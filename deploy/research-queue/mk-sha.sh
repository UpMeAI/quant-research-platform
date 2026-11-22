#!/bin/bash
# regenerate DEPLOY.md: head + sha256 table of the unit files and cap-proof.sh
cd "$(dirname "$0")" || exit 1
{ cat DEPLOY.head.md; echo '| File | sha256 |'; echo '|---|---|'; for f in linux/* hk/* cap-proof.sh mac/*; do echo "| \`$f\` | $(shasum -a 256 "$f" | cut -d' ' -f1) |"; done; } > DEPLOY.md
