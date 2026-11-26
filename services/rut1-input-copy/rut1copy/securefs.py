"""Descriptor-bound filesystem operations for the RUT1 delivery root."""

import hashlib
import json
import os
import stat
from pathlib import Path, PurePosixPath


class UnsafePath(OSError):
    pass


_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW


def _relative_parts(value) -> tuple[str, ...]:
    path = PurePosixPath(str(value))
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise UnsafePath("unsafe relative path")
    return path.parts


def _open_absolute_dir(path: Path) -> int:
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise UnsafePath("root must be an absolute canonical path")
    fd = os.open("/", _DIR_FLAGS)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except (OSError, ValueError) as exc:
        os.close(fd)
        raise UnsafePath("root contains a missing or non-directory component") from exc


def _open_dir_at(root_fd: int, parts: tuple[str, ...], *, create: bool = False) -> int:
    fd = os.dup(root_fd)
    try:
        for part in parts:
            try:
                next_fd = os.open(part, _DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o755, dir_fd=fd)
                next_fd = os.open(part, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except (OSError, ValueError) as exc:
        os.close(fd)
        if isinstance(exc, FileNotFoundError):
            raise
        raise UnsafePath("path contains a symlink or non-directory component") from exc


def _open_parent(root_fd: int, relative, *, create: bool = False) -> tuple[int, str]:
    parts = _relative_parts(relative)
    return _open_dir_at(root_fd, parts[:-1], create=create), parts[-1]


def _regular_fd(parent_fd: int, name: str, flags: int = os.O_RDONLY, mode: int = 0o644) -> int:
    try:
        fd = os.open(name, flags | os.O_CLOEXEC | os.O_NOFOLLOW, mode, dir_fd=parent_fd)
    except (OSError, ValueError) as exc:
        raise UnsafePath("file is missing, linked, or not safely openable") from exc
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise UnsafePath("file is not regular")
    return fd


def _digest_fd(fd: int) -> str:
    value = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        block = os.read(fd, 1024 * 1024)
        if not block:
            break
        value.update(block)
    return value.hexdigest()


class Root:
    """Open, fixed descriptor for an existing absolute delivery root."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.fd = _open_absolute_dir(self.path)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def ensure_dir(self, relative) -> None:
        fd = _open_dir_at(self.fd, _relative_parts(relative), create=True)
        os.close(fd)

    def tree(self, relative, *, create: bool = False):
        return Tree(_open_dir_at(self.fd, _relative_parts(relative), create=create))

    def lstat(self, relative):
        try:
            parent_fd, name = _open_parent(self.fd, relative)
        except FileNotFoundError:
            return None
        try:
            try:
                return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                return None
        finally:
            os.close(parent_fd)

    def open_regular(self, relative, flags=os.O_RDONLY, mode=0o644, *, create_parents=False):
        parent_fd, name = _open_parent(self.fd, relative, create=create_parents)
        try:
            return _regular_fd(parent_fd, name, flags, mode)
        finally:
            os.close(parent_fd)

    def read_json(self, relative, default=None):
        try:
            fd = self.open_regular(relative)
        except (FileNotFoundError, UnsafePath):
            return default
        try:
            raw = b""
            while True:
                block = os.read(fd, 65536)
                if not block:
                    break
                raw += block
            return json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            return default
        finally:
            os.close(fd)

    def atomic_json(self, relative, payload: dict, mode: int = 0o644) -> None:
        parent_fd, name = _open_parent(self.fd, relative, create=True)
        temporary = f".{name}.tmp.{os.getpid()}"
        fd = None
        try:
            try:
                existing = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                existing = None
            if existing is not None and not stat.S_ISREG(existing.st_mode):
                raise UnsafePath("atomic destination is not a regular file")
            fd = _regular_fd(
                parent_fd,
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            raw = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode("utf-8")
            view = memoryview(raw)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
            os.fchmod(fd, mode)
            os.close(fd)
            fd = None
            os.rename(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
            os.close(parent_fd)


class Tree:
    """Held directory descriptor used for verification and installation."""

    def __init__(self, fd: int):
        self.fd = fd

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _parent(self, relative, *, create=False):
        return _open_parent(self.fd, relative, create=create)

    def ensure_dir(self, relative):
        fd = _open_dir_at(self.fd, _relative_parts(relative), create=True)
        os.close(fd)

    def subtree(self, relative, *, create=False):
        return Tree(_open_dir_at(self.fd, _relative_parts(relative), create=create))

    def entries(self) -> dict[str, str]:
        output = {}

        def walk(directory_fd, prefix):
            for name in sorted(os.listdir(directory_fd)):
                relative = f"{prefix}/{name}" if prefix else name
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    output[relative] = "dir"
                    child = os.open(name, _DIR_FLAGS, dir_fd=directory_fd)
                    try:
                        walk(child, relative)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    output[relative] = "file"
                elif stat.S_ISLNK(info.st_mode):
                    output[relative] = "symlink"
                else:
                    output[relative] = "special"

        walk(self.fd, "")
        return output

    def read_bytes(self, relative) -> bytes:
        parent_fd, name = self._parent(relative)
        try:
            fd = _regular_fd(parent_fd, name)
        finally:
            os.close(parent_fd)
        try:
            pieces = []
            while True:
                block = os.read(fd, 1024 * 1024)
                if not block:
                    break
                pieces.append(block)
            return b"".join(pieces)
        finally:
            os.close(fd)

    def atomic_json(self, relative, payload: dict, mode: int = 0o644) -> None:
        parent_fd, name = self._parent(relative, create=True)
        temporary = f".{name}.tmp.{os.getpid()}"
        fd = None
        try:
            try:
                existing = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                existing = None
            if existing is not None and not stat.S_ISREG(existing.st_mode):
                raise UnsafePath("atomic destination is not a regular file")
            fd = _regular_fd(
                parent_fd,
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            raw = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode("utf-8")
            view = memoryview(raw)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
            os.fchmod(fd, mode)
            os.close(fd)
            fd = None
            os.rename(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
            os.close(parent_fd)

    def digest(self, relative) -> str:
        parent_fd, name = self._parent(relative)
        try:
            fd = _regular_fd(parent_fd, name)
        finally:
            os.close(parent_fd)
        try:
            return _digest_fd(fd)
        finally:
            os.close(fd)

    def lstat(self, relative):
        try:
            parent_fd, name = self._parent(relative)
        except FileNotFoundError:
            return None
        try:
            try:
                return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                return None
        finally:
            os.close(parent_fd)

    def install_from(self, source, relative, expected_digest: str) -> None:
        src_parent, src_name = source._parent(relative)
        dst_parent, dst_name = self._parent(relative, create=True)
        source_fd = None
        temporary_fd = None
        temporary = f".{dst_name}.copy.{os.getpid()}"
        try:
            source_fd = _regular_fd(src_parent, src_name)
            temporary_fd = _regular_fd(
                dst_parent,
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            value = hashlib.sha256()
            while True:
                block = os.read(source_fd, 1024 * 1024)
                if not block:
                    break
                value.update(block)
                view = memoryview(block)
                while view:
                    written = os.write(temporary_fd, view)
                    view = view[written:]
            if value.hexdigest() != expected_digest:
                raise UnsafePath("source changed after verification")
            os.fsync(temporary_fd)
            os.fchmod(temporary_fd, 0o444)
            os.close(temporary_fd)
            temporary_fd = None
            os.link(
                temporary,
                dst_name,
                src_dir_fd=dst_parent,
                dst_dir_fd=dst_parent,
                follow_symlinks=False,
            )
            os.unlink(temporary, dir_fd=dst_parent)
            os.fsync(dst_parent)
        finally:
            if source_fd is not None:
                os.close(source_fd)
            if temporary_fd is not None:
                os.close(temporary_fd)
            try:
                os.unlink(temporary, dir_fd=dst_parent)
            except FileNotFoundError:
                pass
            os.close(src_parent)
            os.close(dst_parent)

    def digest_existing(self, relative):
        info = self.lstat(relative)
        if info is None:
            return None
        if not stat.S_ISREG(info.st_mode):
            raise UnsafePath("destination is not a regular file")
        return self.digest(relative)
