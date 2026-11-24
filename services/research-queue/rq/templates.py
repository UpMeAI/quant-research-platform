"""Template registry (§4.1). A template is admissible only when its sha256 is pinned by the coordinator's freeze page."""
import json
import pathlib
import re

from . import core

REQUIRED = ("template_id", "version", "kinds", "producer_host", "run_host", "agent_host", "weight_class", "io_class", "argv", "params", "inputs",
            "outputs", "expected_duration_s", "evidence_matrix", "authority_shas", "idempotent", "transient_budget", "completion", "requires_trl", "markets")
HOSTS = ("LINUX", "HK", "BY_MARKET")
WEIGHTS = ("W0", "W1", "W2", "NET")
IO_CLASSES = ("NONE", "LANE1_DB", "LANE1_FILES", "HK_DB")
COMPLETIONS = ("SELF_VALIDATED", "GATE_AND_CHECK", "HEAVY_MATRIX")
MARKETS = ("CN_A", "US_EQUITY", "CRYPTO", "NONE")
PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
HEAVY_KINDS = ("HEAVY_Q0_LANE", "HEAVY_LAB_E2E")
HEAVY_FIELDS = ("spec_schema", "pause_mode", "unit_props", "floor_gib", "driver_contract", "terminal_map", "stop_lead_s")
HEAVY_UNIT_PROPS = ("Nice=19", "IOSchedulingClass=idle", "CPUAffinity=0-7 16-23", "CPUQuota=600%", "MemoryMax=24G")


def template_sha256(t):
    return core.sha256_hex(core.canonical(t))


def validate_template(t):
    errs = []
    for k in REQUIRED:
        if k not in t:
            errs.append("missing " + k)
    if errs:
        return errs
    if t["producer_host"] not in HOSTS:
        errs.append("producer_host")
    if t["run_host"] not in HOSTS:
        errs.append("run_host")
    if t["agent_host"] not in HOSTS:
        errs.append("agent_host")
    if t["weight_class"] not in WEIGHTS:
        errs.append("weight_class")
    if t["io_class"] not in IO_CLASSES:
        errs.append("io_class")
    if t["completion"] not in COMPLETIONS:
        errs.append("completion")
    if not isinstance(t["argv"], list) or not t["argv"] or not all(isinstance(a, str) for a in t["argv"]):
        errs.append("argv must be a non-empty list of strings")
    if not set(t["markets"]) <= set(MARKETS):
        errs.append("markets")
    em = t["evidence_matrix"]
    if not (isinstance(em, dict) and em.get("id") and re.fullmatch(r"[0-9a-f]{64}", str(em.get("sha256", "")))):
        errs.append("evidence_matrix needs id and a 64-hex sha256")
    if not t["idempotent"] and not t.get("recovery_argv"):
        errs.append("a non-idempotent template needs recovery_argv")
    for a in list(t["argv"]) + list(t.get("recovery_argv") or []):
        for name in PLACEHOLDER.findall(a):
            if name not in t["params"]:
                errs.append("argv placeholder without a param: " + name)
    for name, pat in t["params"].items():
        try:
            re.compile(pat)
        except re.error:
            errs.append("param pattern " + name)
    if not isinstance(t["transient_budget"], int) or t["transient_budget"] < 0:
        errs.append("transient_budget")
    is_heavy = any(k in HEAVY_KINDS for k in t["kinds"])
    if is_heavy or t["completion"] == "HEAVY_MATRIX":
        h = t.get("heavy")
        if not isinstance(h, dict):
            errs.append("missing heavy")
            return errs
        for k in HEAVY_FIELDS:
            if k not in h:
                errs.append("missing heavy." + k)
        if t["completion"] != "HEAVY_MATRIX":
            errs.append("heavy completion")
        if h.get("spec_schema") != "HEAVY_RUN_SPEC_V1":
            errs.append("heavy.spec_schema")
        if h.get("pause_mode") not in ("COOPERATIVE_FILE", "DOCKER_PAUSE"):
            errs.append("heavy.pause_mode")
        if tuple(h.get("unit_props") or ()) != HEAVY_UNIT_PROPS:
            errs.append("heavy.unit_props")
        if h.get("floor_gib") != 150 or h.get("driver_contract") != "HEAVY_DRIVER_V1" or h.get("terminal_map") != "HEAVY_TERMINAL_MAP_V1":
            errs.append("heavy contract")
        if not isinstance(h.get("stop_lead_s"), int) or h.get("stop_lead_s", 0) < 120:
            errs.append("heavy.stop_lead_s")
        expected = ["/usr/bin/python3", "-m", "rq", "heavy-run", "{spec_sha256}"]
        if t["argv"] != expected or t.get("recovery_argv") != expected + ["--resume"] or set(t["params"]) != {"spec_sha256"}:
            errs.append("heavy argv")
        if any("/heavy-specs/" in a or a.endswith(".json") for a in t["argv"] + list(t.get("recovery_argv") or [])):
            errs.append("heavy argv path")
    return errs


def render_argv(argv, params):
    return [PLACEHOLDER.sub(lambda m: str(params[m.group(1)]), a) for a in argv]


class Registry:
    def __init__(self, templates, pins):
        self.templates = list(templates)
        self.pins = list(pins)
        self._by_id = {t["template_id"]: t for t in self.templates}

    def get(self, template_id):
        return self._by_id.get(template_id)

    def is_frozen(self, t):
        sha = template_sha256(t)
        return any(p.get("template_id") == t["template_id"] and p.get("template_sha256") == sha for p in self.pins)

    @classmethod
    def load(cls, templates_path, pins_path):
        t = json.loads(pathlib.Path(templates_path).read_text())
        p = json.loads(pathlib.Path(pins_path).read_text()) if pins_path and pathlib.Path(pins_path).exists() else {"pins": []}
        return cls(t["templates"], p["pins"])
