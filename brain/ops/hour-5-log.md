---
type: ops
title: Hour 5 — Remote workers on Fly Machines
tags: [workshop, hour-5, adapters, fly, infrastructure]
---

# Hour 5 — 2026-04-23 — Remote workers

Workshop's Fly deployment had a Hermes agent record but no execution path:
`claude_local` expects the `claude` CLI in the server container, and the
image doesn't ship one. Until this hour, every "agent" on Fly was decorative.

Hour 5 built the minimum viable path so agents can actually execute on
production.

## Decisions

1. **New adapter `claude_remote`** — not an extension of `claude_local`.
   Reason: `claude_local`'s `execute.ts` is tightly coupled to local child
   process spawning. Branching it would add upstream-merge pain for no gain.
   Sibling adapter keeps the cleaner path. Shared code (stream-json parsing)
   is imported from `claude-local/server`.
2. **Separate Fly app `workshop-jkrums-workers`** — not a worker pool in the
   main app. Reason: clean separation between control plane (always-on) and
   ephemeral workers. One image → many per-run Machines spawned on demand.
3. **Result-return via callback POST, not log scraping.** Fly Machines API
   has no REST logs endpoint; alternatives (flyctl subprocess, NATS
   subscription) are ugly. Worker POSTs the full buffered stdout/stderr to
   a new `/api/worker-callbacks/:runId/complete` endpoint when done; adapter
   polls `/status` every 2s. In-memory store on the control plane; losable
   across restarts, which is fine — next heartbeat retries.
4. **No session resumption in MVP.** Each run spawns a fresh Machine. Fine
   for daily-briefing-class workloads. Revisit when long-running
   multi-heartbeat flows arrive.
5. **Persona-skill DB binding deferred to H6.** Agent-adapter pairing is
   hardcoded at the agent record level for now.
6. **Scope-cut:** skipped log streaming (UI sees a single blob at the end),
   budget enforcement (log-only), code sharing between local/remote
   adapters (premature abstraction).

## Cost model

Shared-cpu-1x Machine ≈ $0.0000008/sec. Typical run 30s-5min = $0.0001-$0.001.
Daily briefing (once/day × 30) ≈ $0.03/mo in machine time, plus per-token
Anthropic spend. Memory capped at 512MB, adapter poll deadline at 15min.

## Architecture

```
Control plane (workshop-jkrums.fly.dev)
  ↳ Hermes heartbeat fires
  ↳ claude_remote adapter.execute()
      ↳ POST api.machines.dev → create Machine (env: prompt, keys, callback URL)
      ↳ Poll /api/worker-callbacks/:runId/status every 2s
Worker (ephemeral Machine in workshop-jkrums-workers)
  ↳ shim.mjs reads env → spawns `claude --print -` with stream-json
  ↳ Buffers stdout/stderr (8MB cap per stream)
  ↳ POSTs completion → control plane's /api/worker-callbacks/:runId/complete
  ↳ Machine auto-destroys on exit
Control plane
  ↳ Poll returns completion → parse stream-json → AdapterExecutionResult
  ↳ Heartbeat records run result, issue advances
```

## Files

- `packages/adapters/claude-remote/` — new adapter (execute, fly-machines client, session codec)
- `worker/` — Dockerfile + shim.mjs for the Machine image
- `server/src/routes/worker-callbacks.ts` + `services/worker-callback-store.ts` — callback endpoints
- Registry wiring: `server/src/adapters/{registry.ts,builtin-adapter-types.ts}`
- Dockerfile: added `packages/adapters/claude-remote/package.json` COPY

## Required env on control plane before this works

- `FLY_API_TOKEN` — Fly personal/org token with access to the worker app
- `ANTHROPIC_API_KEY` — forwarded to each worker
- `PAPERCLIP_PUBLIC_URL` (or reuses `PAPERCLIP_AUTH_PUBLIC_BASE_URL`) — so workers can call back

## Smoke test journey (production, 2026-04-23 morning)

End-to-end smoke test on `https://workshop-jkrums.fly.dev` blocked on three
sequential bugs before passing. All three were environmental, not adapter
bugs — but each manifested identically (428-byte run log ending at
"spawning Fly Machine…" with no subsequent log).

1. **Worker app v1 release failed** during initial `flyctl deploy`, so the
   registry tag pointed nowhere. `flyctl releases --app workshop-jkrums-workers`
   showed `v1 │ failed` and `flyctl image show` was empty. Fix: rerun deploy
   from `/worker`, then update `WORKSHOP_WORKER_IMAGE` secret on the control
   plane to the new deployment tag.
2. **`FLY_API_TOKEN` was unauthorized** for every Machines API call, even
   reading its own app (`{"error":"unauthorized"}`). Cause unclear — the
   original token may have been app-scoped rather than org-scoped. Fix:
   `flyctl tokens create org -o personal -n workshop-control-plane -x 8760h`
   and set as the new `FLY_API_TOKEN` secret. Org-scoped covers both
   control plane and workers app.
3. **Claude CLI refused `--dangerously-skip-permissions` as root.** Stderr:
   `cannot be used with root/sudo privileges for security reasons`. Fix:
   add a non-root `worker` user in `worker/Dockerfile` with
   `HOME=/home/worker`.

Debug technique that unlocked this: the adapter's `createMachine` failure
path returns `errorMessage` on the run result but does **not** call
`onLog()`, so the heartbeat ndjson log file silently ends at the "spawning"
line. Direct checks (`flyctl machines list` empty + `flyctl logs --app
workshop-jkrums-workers` showing the actual stderr from the worker) were
how we saw past the 428-byte dead end each time.

Final successful run `bfe826c0-6470-435b-b7a2-83c2079f5e68` (52s,
$0.295, 10 turns) — agent called paperclipMe via MCP, commented "hello",
and PATCH'd LOB-3 to `done`.

## Next

- Hour 6: `persona_skill_path` on the agents table so the worker reads the
  agent's persona skill at boot without redeploying.
- Add streaming log forwarding so the UI shows progress mid-run.
- Switch Hermes's daily briefing to invoke via `claude_remote` instead of
  the in-process placeholder.
