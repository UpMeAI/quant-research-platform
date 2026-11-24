"""CLI for the progress page generator."""

from __future__ import annotations

import argparse

from .run import run_once


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python3 -m progress")
    sub = parser.add_subparsers(dest="command")
    run = sub.add_parser("run")
    run.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    if args.command != "run":
        return 64
    return run_once(args.config)


if __name__ == "__main__":
    raise SystemExit(main())
