FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@latest

# Claude CLI refuses to run --dangerously-skip-permissions as root.
RUN useradd --create-home --shell /bin/bash worker
WORKDIR /worker
COPY shim.mjs ./shim.mjs
COPY dist/paperclip-mcp-server.mjs /worker/mcp/paperclip-mcp-server.mjs
RUN chmod +x /worker/mcp/paperclip-mcp-server.mjs && chown -R worker:worker /worker
USER worker

ENV NODE_ENV=production HOME=/home/worker
CMD ["node", "/worker/shim.mjs"]
