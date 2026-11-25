FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

WORKDIR /app
COPY . /app
USER 1000:1000
ENTRYPOINT ["node", "services/research-queue-agent/cli.js"]
