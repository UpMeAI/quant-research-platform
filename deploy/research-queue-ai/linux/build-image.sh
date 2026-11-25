#!/bin/sh
# Build the keyless AQ agent from one exact commit and publish its exact runtime environment.
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <commit> <rq-agent-image.env> <build-receipt.json>" >&2
  exit 64
fi

COMMIT=$1
ENV_OUT=$2
RECEIPT_OUT=$3
BASE='node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
REPO_ROOT=$(git rev-parse --show-toplevel)
SHA=$(git -C "$REPO_ROOT" rev-parse --verify "${COMMIT}^{commit}")
case "$SHA" in *[!0-9a-f]*) echo "commit did not resolve to a 40-hex object" >&2; exit 65 ;; esac
if [ "${#SHA}" -ne 40 ]; then
  echo "commit did not resolve to a 40-hex object" >&2
  exit 65
fi
SHORT_SHA=$(printf '%s' "$SHA" | cut -c 1-12)
TAG="rq-agent:${SHORT_SHA}"
: "${TMPDIR:?TMPDIR must name the approved scratch filesystem}"
BUILD_DIR=$(mktemp -d "$TMPDIR/rq-agent-build.XXXXXX")
trap 'rm -rf "$BUILD_DIR"' EXIT HUP INT TERM

# The context is only the committed tree. No working-tree files or node_modules are admitted.
(cd "$REPO_ROOT" && git archive --format=tar --output="$BUILD_DIR/source.tar" "$SHA")
mkdir "$BUILD_DIR/context"
tar -xf "$BUILD_DIR/source.tar" -C "$BUILD_DIR/context"

# The digest-pinned base must already exist locally: --pull=false and --network none forbid fallback.
docker image inspect "$BASE" >/dev/null
DOCKER_BUILDKIT=1 docker build --pull=false --network none \
  --label "org.opencontainers.image.revision=$SHA" \
  --file "$BUILD_DIR/context/deploy/research-queue-ai/linux/Dockerfile" \
  --tag "$TAG" "$BUILD_DIR/context"
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$TAG")

umask 077
mkdir -p "$(dirname "$ENV_OUT")" "$(dirname "$RECEIPT_OUT")"
ENV_TMP="${ENV_OUT}.tmp.$$"
RECEIPT_TMP="${RECEIPT_OUT}.tmp.$$"
printf 'RQ_AGENT_IMAGE=%s\n' "$TAG" >"$ENV_TMP"
printf '{"schema":"RQ_AGENT_IMAGE_BUILD_V1","commit":"%s","tag":"%s","RQ_AGENT_IMAGE":"%s","RQ_AGENT_IMAGE_ID":"%s","base":"%s"}\n' \
  "$SHA" "$TAG" "$TAG" "$IMAGE_ID" "$BASE" >"$RECEIPT_TMP"
mv "$ENV_TMP" "$ENV_OUT"
mv "$RECEIPT_TMP" "$RECEIPT_OUT"
printf 'RQ_AGENT_IMAGE=%s\nRQ_AGENT_IMAGE_ID=%s\n' "$TAG" "$IMAGE_ID"
