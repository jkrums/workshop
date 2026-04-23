---
type: ops
title: Hour 7 — Paperclip MCP inside claude_remote workers
tags: [workshop, hour-7, mcp, claude-remote, hermes]
date: 2026-04-23
---

# Hour 7 — 2026-04-23 — Hermes gets hands, not just eyes

Hour 6 proved Hermes could write prose and POST to Telegram. But he was
running on a bare Claude CLI — no Paperclip tools inside the worker.
The daily briefing only knew what the control plane pre-computed and
crammed into the prompt (4 counts). If Hermes wanted to reference a
specific issue, he was guessing.

Hour 7 bundles the in-repo Paperclip MCP stdio server into the worker
image and wires it in via `--mcp-config` at every spawn. First run
with it live — Hermes called `paperclipInboxLite` before writing the
briefing and referenced the "no routines yet" gap from real data, not
the injected counts.

## Decisions

1. **Bundle monorepo source, not the npm-published `@paperclipai/mcp-server`.**
   We fork `paperclipai/paperclip`; the published package would drift
   against whatever our in-repo MCP is serving. esbuild the local
   `packages/mcp-server/src/stdio.ts` into a single standalone
   `.mjs` and copy it into the image. Workshop's worker always runs
   Workshop's MCP.
2. **Single-file bundle with `external: []`.** The MCP server is pure
   JS (MCP SDK + zod + the shared schema package). Inlining
   everything means the worker image has no `node_modules` to manage
   — just the Claude CLI (`npm install -g`) and the bundled MCP
   sitting at `/worker/mcp/paperclip-mcp-server.mjs`. Bundle is 855KB;
   image went from 215MB → 230MB. Acceptable.
3. **Inline `--mcp-config <json>`, not a config file.** Claude CLI
   accepts the MCP config as a JSON string or a file path. Inline
   is simpler (no extra `COPY` of a JSON file, no dev-vs-prod path
   divergence) and easy to override via `PAPERCLIP_MCP_SERVER_PATH`
   env for local testing.
4. **`--strict-mcp-config` to ignore ambient CLI config.** The worker
   image has `npm install -g @anthropic-ai/claude-code@latest` and
   the Claude CLI reads `~/.claude.json` by default. Without strict
   mode, any MCP servers from the host would leak in. Strict mode
   forces Claude to only see what we pass explicitly.
5. **No MCP-layer permission filtering.** The Paperclip MCP stdio
   server authenticates via `PAPERCLIP_API_KEY` (the agent's key);
   the API itself enforces what that agent can read/write. We do
   not filter tools at the MCP layer — Hermes has every tool
   available and the API blocks anything his agent permissions
   don't cover. This is how the desktop Claude integration already
   works; no reason to diverge.
6. **Prompt explicitly scopes MCP usage to one call.** The briefing
   prompt now includes an "Enrich via Paperclip MCP" section that
   says: call `paperclipInboxLite` once, don't fan out. Leaving the
   call discretionary would risk Hermes chaining five `paperclipGet*`
   tool calls for a two-line briefing. Explicit budget, explicit
   tool.
7. **Scope cuts:** no MCP log forwarding into heartbeat run logs
   (MCP tool calls only show up in the Claude CLI stream-json, which
   we already echo), no per-agent MCP tool filtering, no dropping
   the pre-computed counts yet (keep them as a reliability floor
   in case MCP call fails; revisit once MCP has been stable for a
   week).

## Architecture

```
Build time (local)
  ↳ worker/build-mcp.mjs
      ↳ esbuild packages/mcp-server/src/stdio.ts
      ↳ → worker/dist/paperclip-mcp-server.mjs (855KB, bundled)

Docker build
  ↳ COPY shim.mjs /worker/shim.mjs
  ↳ COPY dist/paperclip-mcp-server.mjs /worker/mcp/paperclip-mcp-server.mjs

Runtime (per spawn)
  ↳ shim.mjs reads env
  ↳ Builds { mcpServers: { paperclip: { type: "stdio",
       command: "node", args: ["/worker/mcp/paperclip-mcp-server.mjs"] } } }
  ↳ spawn("claude", [
       "--print", "-",
       "--output-format", "stream-json",
       "--verbose",
       "--dangerously-skip-permissions",
       "--mcp-config", JSON.stringify(mcpConfig),
       "--strict-mcp-config",
       "--model", model,
     ])
  ↳ Claude CLI spawns the MCP as a stdio child
  ↳ MCP inherits env: PAPERCLIP_API_URL, PAPERCLIP_API_KEY,
       PAPERCLIP_RUN_ID → auth + run correlation just works
  ↳ Hermes sees `mcp__paperclip__paperclip*` tools in his toolbox
  ↳ Invokes paperclipInboxLite → MCP → REST API → returns JSON
  ↳ Writes briefing citing real inbox state
  ↳ POSTs to Telegram, exits
```

## Files

- `worker/build-mcp.mjs` — new esbuild script, 31 lines
- `worker/.gitignore` — new; excludes `dist/` and `node_modules/`
- `worker/Dockerfile` — `COPY dist/paperclip-mcp-server.mjs` into
  `/worker/mcp/`, chmod +x
- `worker/shim.mjs` — build MCP config, pass `--mcp-config` and
  `--strict-mcp-config` flags
- `server/src/services/daily-briefing.ts` — add "Enrich via Paperclip
  MCP" section to the prompt; nudge toward specific issue identifiers
  ("e.g. `LOB-3`") and cap at one inbox read

## Deploy

```
cd worker && node build-mcp.mjs
  → wrote worker/dist/paperclip-mcp-server.mjs (855KB)

flyctl deploy --app workshop-jkrums-workers --strategy immediate --ha=false --no-public-ips
  → registry.fly.io/workshop-jkrums-workers:deployment-01KPWY04WT2DW5J2595S6M7TMR
  → 230MB image (was 215MB pre-bundle)

flyctl secrets set WORKSHOP_WORKER_IMAGE="…01KPWY04WT…" --app workshop-jkrums --stage
flyctl deploy --app workshop-jkrums
  → picks up briefing prompt update + new worker image tag
```

No DB migrations. No new secrets. No schema changes.

## Smoke test (2026-04-23 10:33 UTC)

Triggered `/api/routines/daily-briefing/run-now` via browser fetch.

Run `ed7bfa9d-fe33-4064-891d-bc3166dddc38`:

- 10:33:42 — worker boots, shim prints `workshop-worker starting
  run=ed7bfa9d-… model=claude-opus-4-7`
- 10:34:09 — Claude CLI invokes
  `mcp__paperclip__paperclipInboxLite` (input `{}`) — **first MCP
  call from a Workshop worker**
- 10:34:30 — `claude exited code=0 signal=null stdoutBytes=15773`
- 10:34:30 — `[shim] completion posted, exiting`

End-to-end ~48 seconds. Telegram received the briefing. Hermes
referenced the "no routines live yet" gap from the actual MCP
response rather than just restating the injected count of `0`.

## Next

- **Hour 8:** Routines as a first-class UI concept. Currently the
  daily briefing is a hardcoded `setInterval` in `server/src/index.ts`
  keyed on env vars. Should be a `routines` row with a cron trigger
  so it appears in `/routines` alongside future recurring work, and
  so Janis can enable/disable/edit cadence from the UI instead of
  redeploying.
- Once MCP has been running stable for a week, consider dropping
  the pre-computed counts from the briefing prompt entirely and
  letting Hermes do both the inbox read and any follow-up reads
  himself. That's the direction — prompt should tell Hermes *what
  briefing to write*, not hand-feed him data.
- Backfill other personas with MCP access: Atlas, Iris, Rory will
  all need it when they come online. The worker image is
  persona-agnostic; just need their agent rows + API keys.
- Watch for MCP call latency in worker logs. If it becomes a
  meaningful fraction of runtime we'll want connection pooling or
  a longer-lived MCP process; right now it spawns fresh per run.
