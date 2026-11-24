"""Fail-closed authority check for the migrated QRP research web."""

import dataclasses
import importlib.util
import os
import pathlib
import re
import subprocess


POST_SWITCH_VAR = "/srv/research-lane/qrp/var"
PRE_SWITCH_VAR = "/srv/research-lane/mirror/mac/qrp-var"
NODE = "/srv/research-lane/tools/node-v23.11.0-linux-x64/bin/node"
AUTHORITY = "V8_1_COORDINATOR"
STATUS = "/srv/research-lane/ops-logs/qrp-research-web/status.json"
SHA64 = re.compile(r"[0-9a-f]{64}")


class AuthorityError(RuntimeError):
    pass


def _fail(code):
    raise AuthorityError(code)


@dataclasses.dataclass(frozen=True)
class RuntimeConfig:
    mode: str
    root: pathlib.Path
    pinned_sha: str
    var_root: pathlib.Path
    data_dir: pathlib.Path
    desk_root: pathlib.Path
    review_root: pathlib.Path
    node: pathlib.Path
    host: str
    port: int
    status: pathlib.Path


class ProductionFacts:
    def is_dir(self, path):
        return pathlib.Path(path).is_dir() and not pathlib.Path(path).is_symlink()

    def is_file(self, path):
        return pathlib.Path(path).is_file() and not pathlib.Path(path).is_symlink()

    def is_writable(self, path):
        return os.access(path, os.W_OK)

    def authority_marker_active(self, path):
        return pathlib.Path(path).is_file()

    def files_equal(self, left, right):
        try:
            first = pathlib.Path(left).read_bytes()
            return bool(first) and first == pathlib.Path(right).read_bytes()
        except OSError:
            return False

    def git_head(self, path):
        result = subprocess.run(
            ["/usr/bin/git", "-C", str(path), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=15, check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else None

    def git_clean(self, path):
        result = subprocess.run(
            ["/usr/bin/git", "-C", str(path), "status", "--porcelain"],
            capture_output=True, text=True, timeout=15, check=False,
        )
        return result.returncode == 0 and result.stdout == ""

    def delegate_guard(self, module, config):
        path = pathlib.Path(module)
        if not self.is_file(path):
            _fail("QRP_VAR_GUARD_UNAVAILABLE")
        spec = importlib.util.spec_from_file_location("qrp_var_authority_guard", path)
        if not spec or not spec.loader:
            _fail("QRP_VAR_GUARD_UNAVAILABLE")
        loaded = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(loaded)
        except Exception as exc:
            raise AuthorityError("QRP_VAR_GUARD_UNAVAILABLE") from exc
        if not callable(getattr(loaded, "guard_qrp_var", None)):
            _fail("QRP_VAR_GUARD_UNAVAILABLE")
        return loaded.guard_qrp_var(config)


def _need(env, name):
    value = env.get(name)
    if not isinstance(value, str) or not value:
        _fail("QRP_WEB_CONFIG_MISSING:" + name)
    return value


def _under_lane(path):
    resolved = pathlib.PurePosixPath(path)
    return resolved.is_absolute() and tuple(resolved.parts[:3]) == ("/", "srv", "research-lane")


def validate(env=None, *, facts=None):
    env = dict(os.environ if env is None else env)
    facts = facts or ProductionFacts()
    mode = _need(env, "QRP_WEB_MODE")
    if mode not in ("PRE_SWITCH_COMPARE", "POST_SWITCH"):
        _fail("QRP_WEB_MODE_INVALID")
    for secret in ("QRP_RUNTIME_TOKEN", "QRP_RESEARCH_TOKEN"):
        if env.get(secret):
            _fail(secret + "_MUST_BE_UNSET")
    if env.get("QRP_WEB_UPLOAD", "OFF") != "OFF":
        _fail("QRP_UPLOAD_FORBIDDEN")

    root_text = _need(env, "QRP_ROOT")
    pinned = _need(env, "QRP_PINNED_SHA")
    expected_root = f"/srv/research-lane/qrp/code/{pinned}"
    if not SHA64.fullmatch(pinned) or root_text != expected_root:
        _fail("QRP_WEB_PIN_INVALID")
    root = pathlib.Path(root_text)
    if not facts.is_dir(root) or facts.git_head(root) != pinned or not facts.git_clean(root):
        _fail("QRP_WEB_PIN_MISMATCH")

    if _need(env, "QRP_NODE") != NODE:
        _fail("QRP_WEB_NODE_INVALID")
    if _need(env, "QRP_HOST") != "127.0.0.1" or _need(env, "QRP_PORT") != "4311":
        _fail("QRP_WEB_LOOPBACK_REQUIRED")
    if _need(env, "QRP_PRODUCT_MILESTONE_AUTHORITY") != AUTHORITY:
        _fail("QRP_WEB_AUTHORITY_INVALID")
    if _need(env, "QRP_WEB_STATUS") != STATUS:
        _fail("QRP_WEB_STATUS_INVALID")

    desk_root = _need(env, "QRP_DESK_ROOT")
    review_root = _need(env, "QRP_DESK_REVIEW_LOOP_ROOT")
    if not _under_lane(desk_root) or not _under_lane(review_root):
        _fail("QRP_WEB_DEPENDENCY_PATH_INVALID")
    if not facts.is_dir(desk_root) or not facts.is_dir(review_root):
        _fail("QRP_WEB_DEPENDENCY_MISSING")

    expected_var = POST_SWITCH_VAR if mode == "POST_SWITCH" else PRE_SWITCH_VAR
    var_root = _need(env, "QRP_VAR_ROOT")
    data_dir = _need(env, "QRP_DATA_DIR")
    if var_root != expected_var or data_dir != expected_var + "/ledger":
        _fail("QRP_WEB_VAR_PATH_INVALID")
    if not facts.is_dir(var_root) or not facts.is_dir(data_dir):
        _fail("QRP_WEB_VAR_MISSING")

    marker = _need(env, "QRP_AUTHORITY_MARKER")
    linux_manifest = _need(env, "QRP_VAR_LINUX_MANIFEST")
    mac_manifest = _need(env, "QRP_VAR_MAC_MANIFEST")
    proof = _need(env, "QRP_MAC_VAR_MODE_PROOF")
    if (marker != "/srv/research-lane/qrp/AUTHORITATIVE"
            or linux_manifest != "/srv/research-lane/qrp/migration/linux-var.sha256"
            or mac_manifest != "/srv/research-lane/qrp/migration/mac-var.sha256"
            or proof != "/srv/research-lane/qrp/migration/mac-var-mode.json"):
        _fail("QRP_WEB_GUARD_PATH_INVALID")

    if mode == "PRE_SWITCH_COMPARE":
        active = getattr(facts, "authority_marker_active", lambda _path: False)(marker)
        if active or facts.is_writable(var_root) or facts.is_writable(data_dir):
            _fail("QRP_VAR_DUAL_WRITABLE")
        equal = getattr(facts, "files_equal", lambda _left, _right: True)(linux_manifest, mac_manifest)
        if not equal:
            _fail("QRP_VAR_MANIFEST_MISMATCH")
    else:
        module = _need(env, "QRP_VAR_GUARD_MODULE")
        expected_module = root_text + "/deploy/research-queue/linux/relay-run.py"
        if module != expected_module:
            _fail("QRP_VAR_GUARD_INVALID")
        facts.delegate_guard(module, {
            "authority_marker": marker,
            "authoritative_dir": var_root,
            "linux_manifest": linux_manifest,
            "mac_manifest": mac_manifest,
            "mac_mode_proof": proof,
        })

    return RuntimeConfig(
        mode=mode, root=root, pinned_sha=pinned, var_root=pathlib.Path(var_root),
        data_dir=pathlib.Path(data_dir), desk_root=pathlib.Path(desk_root),
        review_root=pathlib.Path(review_root), node=pathlib.Path(NODE),
        host="127.0.0.1", port=4311, status=pathlib.Path(STATUS),
    )
