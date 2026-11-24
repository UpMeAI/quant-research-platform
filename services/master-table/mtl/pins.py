"""Deploy-time pins. Ops replaces every placeholder in its reviewed deploy commit."""

from .errors import MtlError


FROZEN_REV = "PINS_NOT_SET"
FROZEN_JSON_SHA256 = "PINS_NOT_SET"
FROZEN_MD_SHA256 = "PINS_NOT_SET"
JOIN_MAP_SHA256 = "PINS_NOT_SET"
TSTART_REGISTRY_SHA256 = "PINS_NOT_SET"


def require_set():
    values = (
        FROZEN_REV,
        FROZEN_JSON_SHA256,
        FROZEN_MD_SHA256,
        JOIN_MAP_SHA256,
        TSTART_REGISTRY_SHA256,
    )
    if any(value == "PINS_NOT_SET" for value in values):
        raise MtlError("PINS_NOT_SET", 3)
    return values
