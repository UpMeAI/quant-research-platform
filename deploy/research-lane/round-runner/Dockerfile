# RF1116 P2 round runner (GP only). Build on the research lane from a QRP checkout at the reviewed merge commit:
#   docker build -f deploy/research-lane/round-runner/Dockerfile -t qrp-round-runner:<commit12> .
# Node is pinned to an exact release; dependencies come only from package-lock.json (npm ci). The image holds code and the
# in-repo freeze copies (docs/freeze) and operator evidence (docs/evidence); market data, the holdout and the ledger are mounts.
FROM node:22.12.0-bookworm-slim

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
