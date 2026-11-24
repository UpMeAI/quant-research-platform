"""CLI for the progress page generator."""

from __future__ import annotations

import argparse

from .run import run_once


class UsageError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise UsageError(message)


def main(argv=None):
    parser = Parser(prog="python3 -m progress")
    sub = parser.add_subparsers(dest="command")
    run = sub.add_parser("run")
    run.add_argument("--config", required=True)
    run.add_argument("--lock-held", action="store_true", help=argparse.SUPPRESS)
    try:
        args = parser.parse_args(argv)
    except UsageError:
        return 64
    if args.command != "run":
        return 64
    return run_once(args.config, lock_held=args.lock_held)


if __name__ == "__main__":
    raise SystemExit(main())
