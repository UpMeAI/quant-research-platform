# RF1116 P2 round runner (GP only). Build on the research lane from a QRP checkout at the reviewed merge commit:
#   docker build -f deploy/research-lane/round-runner/Dockerfile -t qrp-round-runner:<commit12> .
# The base image is pinned by digest: Node 22.23.3, the lane's local node:22-bookworm-slim (Docker Hub is blocked from the lane, so
# build with --pull=false; DEPLOY.md checks the digest first). Dependencies come only from package-lock.json (npm ci). The image holds
# code, the in-repo freeze copies (docs/freeze) and operator evidence (docs/evidence); market data, the holdout and the ledger are mounts.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    TZ=Asia/Shanghai

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY . .

# Run as the image's unprivileged node user (uid 1000); under the lane's rootless Docker it maps to a host subuid, never root.
USER 1000:1000
ENTRYPOINT ["node", "--max-old-space-size=20480", "services/mining-sandbox/round-runner/cli.js"]
