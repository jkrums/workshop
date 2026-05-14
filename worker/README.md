# Workshop remote worker

Ephemeral Docker image spawned by the `claude_remote` adapter as a Fly Machine.
Reads a prompt from env, runs `claude` non-interactively, exits. Auto-destroyed
on exit by the control plane.

## What's baked in

- Claude Code CLI (`@anthropic-ai/claude-code@latest`)
- Paperclip MCP server (`/worker/mcp/paperclip-mcp-server.mjs`) — built from
  the in-repo `packages/mcp-server` sources so it matches the running server
- Worker shim (`/worker/shim.mjs`)
- **All bundled Workshop skills** at `/home/worker/.claude/skills/` — Claude
  Code picks these up automatically on spawn. Without this, agents miss
  contracts like `resume: true` for closed-issue updates and the
  `paperclip-create-agent` workflow.

## Deploy (image only — no always-on machine)

Build context is the **repo root** so the Dockerfile can `COPY skills/`. Deploy
from the repo root, not from `worker/`.

```sh
cd /path/to/workshop                            # repo root
node worker/build-mcp.mjs                       # builds worker/dist/paperclip-mcp-server.mjs
flyctl deploy --config worker/fly.toml --ha=false
flyctl scale count 0 --app workshop-jkrums-workers
```

After deploy, update the control plane's `WORKSHOP_WORKER_IMAGE` secret to
point at the new image tag if it's pinned to a specific digest (rather than
`:latest`):

```sh
# Get the new image tag from the deploy output (e.g.
#   registry.fly.io/workshop-jkrums-workers:deployment-XXXXX)
flyctl secrets set WORKSHOP_WORKER_IMAGE=<new-tag> --app workshop-jkrums
```

## Env contract

See `shim.mjs` top comment. `claude_remote` sets these per-spawn via the Fly
Machines API — never bake secrets into the image.
