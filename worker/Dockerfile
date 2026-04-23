FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /worker
COPY shim.mjs ./shim.mjs

ENV NODE_ENV=production
CMD ["node", "/worker/shim.mjs"]
