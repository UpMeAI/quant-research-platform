import json
from helpers import templates


def write(cfg, root, registry=None, **over):
    """Write a config file (JSON) for the CLI, plus the registry and pins files it names."""
    d = cfg.to_dict()
    d.update(over)
    d.pop("registry", None)
    if registry is not None:
        tp, pp = root / "templates.json", root / "pins.json"
        tp.write_text(json.dumps({"schema": "RESEARCH_QUEUE_TEMPLATES_V1", "templates": registry.templates}))
        pp.write_text(json.dumps({"schema": "RESEARCH_QUEUE_TEMPLATE_PINS_V1", "pins": registry.pins}))
        d["templates_path"], d["pins_path"] = str(tp), str(pp)
    p = root / "rq.json"
    p.write_text(json.dumps(d))
    return p
