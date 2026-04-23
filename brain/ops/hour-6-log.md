---
type: ops
title: Hour 6 — Real Hermes daily briefing via claude_remote
tags: [workshop, hour-6, daily-briefing, hermes, telegram]
date: 2026-04-23
---

# Hour 6 — 2026-04-23 — Hermes writes the daily briefing

Hour 5 built the `claude_remote` adapter but only proved it on a
disposable "say hello" issue. The daily-briefing timer on prod was still
the Hour 4 placeholder: it gathered counts in-process and POSTed a raw
stats dump to Telegram directly from the control plane. No persona, no
prose, no agent work — decorative Hermes.

Hour 6 replaced that with a real heartbeat run. The scheduler now
dispatches a `claude_remote` run to Hermes; Hermes reads his persona
skill via the injected prompt, writes the briefing, and POSTs it to
Telegram from inside the ephemeral Machine.

## Decisions

1. **Persona delivery = prompt injection, not skill mount.** The
   scheduler `readFile`s `skills/persona-hermes/SKILL.md` at dispatch
   time and embeds it in the prompt. Deferred mounting the whole
   skill tree into the Fly image; worker stays a tiny Claude CLI shim.
   When we add more personas or multi-skill runs this will need to
   evolve into something like a `persona_skill_path` column on the
   agents table plus a shared volume — not today.
2. **Stats pre-computed on the control plane, not inside the agent.**
   The counts (open issues, pending approvals, active routines,
   companies) are cheap SQL and deterministic. Injecting them into the
   prompt avoids billing Anthropic tokens for a tool-use round trip
   that just re-reads the DB. Hermes doesn't have Paperclip MCP wired
   on `claude_remote` yet anyway.
3. **Hermes agent identity consolidated.** Prod had accumulated four
   Hermes-ish agent rows during Hour 5 iteration. Kept
   `7cd18929-ce7d-42ee-a3da-099385f4de33` (the one with a working API
   key + claude_remote adapter), renamed it to "Hermes", marked the
   legacy `5a115338-…` as "Hermes (legacy)". Hardcoded the canonical
   id in the briefing service with `WORKSHOP_HERMES_AGENT_ID` env
   override.
4. **Telegram POST from worker, not control plane.** Worker already has
   internet; forwarding `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` into
   its env is cheaper than making Hermes call back to a control-plane
   endpoint that then re-POSTs. Curl + env vars is good enough — the
   worker redacts `TELEGRAM_BOT_TOKEN` in the onMeta echo so the token
   doesn't show up in run logs.
5. **`promptTemplate = "{{context.prompt}}"` passthrough.** Hermes's
   `adapter_config.promptTemplate` got seeded to the literal
   `{{context.prompt}}`. The scheduler builds the full prompt and
   passes it via `contextSnapshot.prompt`; the adapter renders the
   template which just substitutes the string unchanged. This avoids
   per-run mutation of `adapterConfig` (which would race with
   concurrent heartbeats).
6. **Manual trigger endpoint behind board auth.** Added
   `POST /api/routines/daily-briefing/run-now` with `req.actor.type
   === "board"` gate — i.e., a logged-in human, not an agent key. Used
   for smoke testing. No rate limit; fine for now because it needs an
   authenticated session to hit.
7. **Scope cuts:** no `routine_runs` row created for briefing
   dispatches (the heartbeat run is the audit trail), no
   `persona_skill_path` schema column, no streaming log forwarding to
   the UI (still single-blob-at-end from Hour 5).

## Architecture

```
Control plane (workshop-jkrums.fly.dev)
  ↳ Timer fires at 08:00 Europe/Zurich (or /run-now manual trigger)
  ↳ daily-briefing.ts
      ↳ gatherCounts(db)                      — 4 SQL count queries
      ↳ readHermesPersona()                   — reads SKILL.md from /app
      ↳ buildBriefingPrompt(persona, counts)  — full prompt string
      ↳ heartbeat.invoke(HERMES_AGENT_ID, "automation",
           { prompt, wakeReason: "daily_briefing", briefing })
Heartbeat service
  ↳ Fetches Hermes + adapter config (claude_remote)
  ↳ Renders promptTemplate "{{context.prompt}}" → full prompt
  ↳ Dispatches to claude_remote adapter
claude_remote adapter
  ↳ POST api.machines.dev with env including
      PAPERCLIP_WORKER_PROMPT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
  ↳ Poll /api/worker-callbacks/:runId/status every 2s
Worker (ephemeral Machine)
  ↳ shim.mjs spawns `claude --print -` with the prompt
  ↳ Hermes writes prose briefing
  ↳ Hermes curls https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage
  ↳ POSTs completion to /api/worker-callbacks/:runId/complete
  ↳ Machine auto-destroys
```

## Files

- `server/src/services/daily-briefing.ts` — full rewrite; now takes a
  `HeartbeatInvoker`, builds prompt, dispatches via `invoke()`
- `server/src/routes/daily-briefing.ts` — new admin route with holder
  pattern (runner bound after heartbeat service is created)
- `server/src/app.ts` — mount daily-briefing route when holder provided
- `server/src/index.ts` — populate holder + start scheduler inside
  `heartbeatSchedulerEnabled` block
- `packages/adapters/claude-remote/src/server/execute.ts` — forward
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env vars (redacted in
  onMeta echo)

## Prod prep (done before deploy)

SQL seeded directly on prod DB (`workshop-jkrums-db`):

```sql
UPDATE agents SET name = 'Hermes'
  WHERE id = '7cd18929-ce7d-42ee-a3da-099385f4de33';
UPDATE agents SET name = 'Hermes (legacy)'
  WHERE id = '2947703d-939e-4309-9158-d8dba8b1f313';
UPDATE agents
  SET adapter_config = '{"promptTemplate":"{{context.prompt}}","timeoutSec":600}'::jsonb
  WHERE id = '7cd18929-ce7d-42ee-a3da-099385f4de33';
```

All control-plane secrets already set from Hour 5: `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `FLY_API_TOKEN`, `ANTHROPIC_API_KEY`,
`WORKSHOP_WORKER_IMAGE`, `PAPERCLIP_AUTH_PUBLIC_BASE_URL` (in fly.toml).

## Smoke test (2026-04-23 09:58 UTC, 11:58 CEST)

Triggered via browser fetch (`POST /api/routines/daily-briefing/run-now`)
— PR #6 merged and deployed cleanly.

Timeline for run `e2ea0e91-c31a-4cae-9126-eb92eca5f32e`:

- 09:58:42 — adapter starts polling `/worker-callbacks/:runId/status`
  (Machine spawn initiated)
- 09:58:48 — worker boots, shim prints `workshop-worker starting
  run=e2ea0e91-… model=claude-opus-4-7`
- 09:59:09 — Claude CLI init
- 09:59:15 — Hermes tool-use `Bash`: curl to Telegram API
- 09:59:17 — Telegram returns HTTP 200
- 09:59:19 — worker POSTs completion, exitCode=0, 6040 bytes stdout

End-to-end ~37 seconds from `/run-now` to Telegram delivery. No
retries, no errors, no approval gates.

The briefing Hermes wrote:

> **Daily Briefing — Thu Apr 23, 2026**
>
> **WHAT:** 2 open issues, 0 pending approvals, 0 active routines, 1 company (Lobbi).
> **WHY:** No routines running yet — daily briefing is firing manually. Workshop is still in seed phase.
> **DECIDE:** Approve seeding the daily-briefing routine on a cron, or keep firing manually for now?
>
> — Hermes

First time a Workshop agent has produced narrative output on its own
— not a templated dump, not a hand-written test message. Hour 5 built
the rails; Hour 6 put Hermes on them.

## Next

- **Hour 7:** Wire Paperclip MCP into the `claude_remote` worker so
  Hermes can read issues/approvals directly instead of receiving
  pre-computed counts. Once MCP is there, re-examine whether the
  briefing service should stop pre-computing counts entirely (let
  Hermes call `paperclipListIssues` himself).
- Consider promoting the briefing to a first-class `routines` row so
  it shows up in the UI alongside other recurring work, instead of
  being a hardcoded timer. Blocked until routine-triggers support
  heartbeat dispatch directly.
- Streaming log forwarding (deferred from Hour 5 and Hour 6). UI still
  only sees the final blob; for a briefing that's fine but for longer
  runs we'll want progress visibility.
- Observe briefing tone over the next few days. If it drifts
  (repetitive, too verbose, stops caring about stats = 0), tighten
  the `persona-hermes` SKILL.md or add a briefing-specific
  constraint line to the prompt.
