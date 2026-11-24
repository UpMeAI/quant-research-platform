import argparse
import json

from .copy import run_phase


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("p1", "p2"), required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    result = run_phase(args.phase, check=args.check)
    if args.check:
        print(json.dumps([list(argv) for argv in result.plan], indent=2))
    else:
        print(json.dumps({"rc": result.code, "reason": result.reason}))
    return result.code


if __name__ == "__main__":
    raise SystemExit(main())
