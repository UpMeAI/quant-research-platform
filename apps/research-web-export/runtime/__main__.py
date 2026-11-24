"""Isolated absolute-directory entry point for the QRP web supervisors."""

import argparse
import importlib.util
import pathlib
import sys


ROOT = pathlib.Path(__file__).resolve().parent.parent
MODULES = ("status", "authority", "parity", "web_run", "tunnel")


def _load(name):
    target = ROOT / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, target)
    if not spec or not spec.loader:
        raise RuntimeError("QRP_RUNTIME_MODULE_INVALID:" + name)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main(argv=None):
    loaded = {name: _load(name) for name in MODULES}
    parser = argparse.ArgumentParser(prog="qrp-research-web")
    parser.add_argument("component", choices=("web", "tunnel", "parity"))
    args, remainder = parser.parse_known_args(argv)
    module = loaded[{"web": "web_run", "tunnel": "tunnel", "parity": "parity"}[args.component]]
    return module.main(remainder)


if __name__ == "__main__":
    raise SystemExit(main())
