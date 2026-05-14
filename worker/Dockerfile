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

# Bake bundled Workshop skills into the worker filesystem so agents read
# them from ~/.claude/skills/ on spawn — no runtime mount, no per-task fetch,
# no /llms-endpoint round-trips. Without this, agents repeat the same mistakes
# (cf. LOB-18 retry storm 2026-05-14 where Engineering didn't know the
# `resume: true` contract documented in adapter-utils/src/server-utils.ts +
# skills/paperclip-create-agent/SKILL.md).
#
# ./skills/ is synced from ../skills/ by build-mcp.mjs (gitignored).
COPY --chown=worker:worker skills/ /home/worker/.claude/skills/

RUN chmod +x /worker/mcp/paperclip-mcp-server.mjs && chown -R worker:worker /worker
USER worker

ENV NODE_ENV=production HOME=/home/worker
CMD ["node", "/worker/shim.mjs"]
