from pathlib import Path

from .errors import MtlError


_FORBIDDEN_PARTS = (".env", "token", "holdout")
_FORBIDDEN_ROOT = Path("/srv/v6-prod")


def _under(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def safe_path(path, allowed_roots):
    candidate = Path(path).expanduser().resolve(strict=False)
    lowered = [part.lower() for part in candidate.parts]
    if _under(candidate, _FORBIDDEN_ROOT):
        raise MtlError(f"PATH_FORBIDDEN:{candidate}", 4)
    if any(any(marker in part for marker in _FORBIDDEN_PARTS) for part in lowered):
        raise MtlError(f"PATH_FORBIDDEN:{candidate}", 4)
    roots = [Path(root).expanduser().resolve(strict=False) for root in allowed_roots]
    if not roots or not any(_under(candidate, root) for root in roots):
        raise MtlError(f"PATH_FORBIDDEN:{candidate}", 4)
    return candidate
