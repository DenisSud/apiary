# pi-bots service image — one container per user (issue #18, local mode).
#
# The image bakes the service and the pi checkout; the user's agents, server
# state and shared agent dir live in the /data volume. Build with
# deploy/build.sh (it assembles the context from the local checkouts) and run
# with deploy/run.sh. See docs/deployment.md.

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git jq ripgrep \
       pandoc poppler-utils python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir trafilatura \
  && npm install -g bun@1.4.2 \
  && git config --system user.name "pi-bots" \
  && git config --system user.email "pi-bots@localhost"

# The service code and the pi checkout the bot servers run from. Both stay
# root-owned (read-only to the runtime user); deploy/run.sh additionally runs
# the container with --read-only, so nothing outside /data and /tmp is
# writable at all.
COPY pi-bots /opt/pi-bots
COPY pi /opt/pi

RUN cd /opt/pi && HUSKY=0 npm ci
RUN cd /opt/pi-bots && bun install --frozen-lockfile && PI_SOURCE_DIR=/opt/pi bun run build

RUN ln -s /opt/pi-bots/packages/connector/bin/pi-bot /usr/local/bin/pi-bot \
  && ln -s /opt/pi-bots/packages/connector/bin/pi-bots-web /usr/local/bin/pi-bots-web \
  && mkdir -p /data/home /data/bots /data/state \
  && chown -R node:node /data

USER node
WORKDIR /opt/pi-bots
ENV HOME=/data/home \
    PI_SOURCE_DIR=/opt/pi \
    PI_BOTS_HOME=/data/bots \
    PI_CONNECTOR_DIR=/data/state \
    PI_SHARED_AGENT_DIR=/data/home/.pi/agent
EXPOSE 8787
CMD ["node", "/opt/pi-bots/packages/connector/src/web-cli.ts", "--host", "0.0.0.0", "--port", "8787"]
