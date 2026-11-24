#!/usr/bin/python3
"""Kill the #137 pin/authority/replay remediation control mutants."""
import pathlib
import shutil
import subprocess
import sys
import tempfile


HERE = pathlib.Path(__file__).resolve().parent
MUTANTS = (
    ("target", "relay-run.py", "if target != HK_GATE_TARGET:", "if False:", "relay-test.py"),
    ("guard-paths", "relay-run.py",
     "if any(config.get(key) != expected.get(key) for key in required):",
     "if False and any(config.get(key) != expected.get(key) for key in required):", "relay-test.py"),
    ("proof-path", "relay-run.py", 'or proof.get("path") != expected["mac_var_path"]', "or False", "relay-test.py"),
    ("git-pin", "relay-run.py", 'if outputs != [pinned, ""]:', "if False:", "relay-test.py"),
    ("parent-nofollow", "relay-run.py",
     "os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW, dir_fd=fd)",
     "os.O_RDONLY | O_DIRECTORY, dir_fd=fd)", "relay-test.py"),
    ("receipt-replay", "trl-registrar-run.py", "if existing != data:", "if False:", "trl-registrar-test.py"),
)


def main():
    killed = []
    with tempfile.TemporaryDirectory(prefix="q137-remediation-mutants-") as temp:
        root = pathlib.Path(temp)
        for name, source_name, old, new, test_name in MUTANTS:
            case = root / name
            shutil.copytree(HERE, case)
            source = case / source_name
            text = source.read_text()
            if old not in text:
                raise SystemExit("MUTANT_PATTERN_MISSING:" + name)
            source.write_text(text.replace(old, new, 1))
            result = subprocess.run([sys.executable, str(case / test_name)], capture_output=True, text=True)
            if result.returncode == 0:
                raise SystemExit("MUTANT_SURVIVED:" + name)
            killed.append(name)
    print("KILLED %d/%d %s" % (len(killed), len(MUTANTS), ",".join(killed)))


if __name__ == "__main__":
    main()
