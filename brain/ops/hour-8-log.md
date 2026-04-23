---
type: ops
title: Hour 8 — Daily briefing as a first-class routine
tags: [workshop, hour-8, routines, hermes, daily-briefing]
date: 2026-04-23
---

# Hour 8 — 2026-04-23 — Briefing joins the routines table

Hour 7 ended with Hermes firing through a private `setInterval` in
`server/src/services/daily-briefing.ts`. It worked, but it was an
island — invisible to `/routines`, untoggleable in the UI,
non-pausable, un-rescheduleable without a code change. Hour 8 rips
that out and seats the briefing at the same table as every future
recurring job: one row in `routines`, one row in `routine_triggers`,
one `dispatch_hook`-style pre-dispatch enrichment, one issue per
morning flowing through the standard assignment pipeline.

This is the bigger bet — routines as the **unified primitive** for
anything recurring. Daily briefing today. Weekly review, monthly
audit, overnight monitoring, periodic reminders — all of them will
use the exact same path. The always-on OS becomes: routines fire →
create issues → workers pick them up → approval queue → human
morning review.

## Decisions

1. **Routines create issues, not direct heartbeat invocations.**
   Forked design: (A) routine dispatch creates an issue, which the
   standard `queueIssueAssignmentWakeup` path then flows to a
   worker; (B) routine dispatch calls `heartbeat.invoke` directly
   with the built prompt. A is the answer because it unifies
   routines with every other piece of work — every run has an
   issue, every issue has a run, nothing routes through a back
   channel. The approval queue, the agent inbox, `paperclipInboxLite`
   — all of them see routine work the same way they see everything
   else.
2. **Pre-dispatch hook as an env-var-gated switch, not a registry.**
   The briefing needs dynamic variables (counts, persona text, date
   label) resolved at fire time. Added `buildPreDispatchVariables`
   in `server/src/services/routine-dispatch-hooks.ts` that runs
   right before variable interpolation in `dispatchRoutineRun`. For
   today it matches on one env var: `WORKSHOP_DAILY_BRIEFING_ROUTINE_ID`.
   When we add a second hook kind, promote the dispatch key to a
   `routines.dispatch_hook` column + registry lookup. No need to
   design the registry now — premature abstraction tax.
3. **Issue description IS the rendered prompt.** When the routine
   fires, the hook feeds variables into the routine's description
   template, producing a fully interpolated prompt string. That
   string becomes the issue's `description`. The adapter's
   `promptTemplate` is just `{{context.paperclipWake.issue.description}}`
   — the adapter doesn't need to know anything about briefings.
   Every routine-dispatched agent reads the same way.
4. **Shallow rebrand hold.** Could have renamed
   `PAPERCLIP_WAKE_PAYLOAD_KEY` to `WORKSHOP_WAKE_PAYLOAD_KEY`
   while in there. Didn't. That's exactly the kind of internal
   string that stays stable so upstream merges keep clean.

## Architecture

**Before (Hour 7):**
```
setInterval in index.ts
  → runDailyBriefing()
    → buildBriefingPrompt(counts, persona)
    → heartbeat.invoke(Hermes, prompt)
      → claude_remote adapter spawns worker
        → worker Telegram POST
```
Briefing is invisible to the UI. Schedule lives in code. No record
in `routines`. No issue created. Nothing in inbox.

**After (Hour 8):**
```
routine_triggers row: cron "0 8 * * *" Europe/Zurich
  → dispatchRoutineRun()
    → buildPreDispatchVariables() — computes counts/persona/date_label
    → interpolateRoutineTemplate(description_template, vars)
    → INSERT issues (description = fully-rendered prompt)
    → queueIssueAssignmentWakeup()
      → heartbeat schedules run with issueId in contextSnapshot
        → buildPaperclipWakePayload fetches issue.description
          → adapter renders promptTemplate {{context.paperclipWake.issue.description}}
            → worker Telegram POST
              → worker comments + closes issue
```
Same worker image, same adapter, same MCP tools. Only new code is
the pre-dispatch hook and the seed data.

## What was built

- **Deleted setInterval path.** Removed `runDailyBriefing`,
  `startDailyBriefingScheduler`, `createBriefingTicker`, and
  `buildBriefingPrompt` from `server/src/services/daily-briefing.ts`.
  Removed the mount in `app.ts` and the scheduler kickoff in
  `index.ts`. Deleted `server/src/routes/daily-briefing.ts`.
- **Shrunk `daily-briefing.ts` to three helpers.** `gatherBriefingCounts`,
  `readHermesPersona`, `formatBriefingDateLabel`. Nothing else.
- **Added `routine-dispatch-hooks.ts`.** Single exported function
  `buildPreDispatchVariables(ctx)`. Dispatches to
  `buildDailyBriefingVariables(db)` iff the routine id matches
  `WORKSHOP_DAILY_BRIEFING_ROUTINE_ID`. Returns the variable bag:
  `persona`, `date_label`, `workshop_url`,
  `{open_issues,pending_approvals,active_routines,companies}_count`.
- **Wired hook into `dispatchRoutineRun`.** One `Object.assign` into
  `automaticVariables` before `resolveRoutineVariableValues`, so
  hook-returned values override any routine-declared defaults.
- **Seeded the routine + trigger + agent adapter config.**
  Dollar-quoted multi-statement SQL transaction, base64-encoded
  and piped through `flyctl ssh` into the Postgres box. Created
  routine `c6024a98-6451-402b-ac9b-672423635b21` with trigger
  (cron `0 8 * * *`, `next_run_at` set to tomorrow morning UTC),
  and updated Hermes's `adapter_config.promptTemplate` to
  `{{context.paperclipWake.issue.description}}`.
- **Landed two follow-up hot-path fixes (PRs #10, #11).** Smoke test
  caught that `buildPaperclipWakePayload`'s `issueSummary` schema
  didn't include `description`. First PR added it to the fallback
  DB query. Second PR caught the real hot path —
  `scheduleHeartbeatRun` pre-builds `issueSummary` from
  `issueContext` and passes it in, bypassing the DB branch.
  Added `description` to `getIssueExecutionContext`'s `select` and
  forwarded it through. Without #11, workers silently received
  empty `PAPERCLIP_WORKER_PROMPT` and exited code 2.

## Smoke test

Run `a816f6fa-d7ae-4997-9baa-99b22edb8274`, dispatched via UI
"Run now" at 13:31 UTC after v20 deploy:

- Worker VM booted in ~6s (image warm from earlier run)
- Shim logged `workshop-worker starting run=a816f6fa-... model=claude-opus-4-7`
  (prompt env present — this was the fix validation)
- Claude called `ToolSearch` → `paperclipInboxLite` → `Bash` (Telegram POST)
- Session: 4 turns, 16s duration, cache hit 84k tokens, cost $0.19
- Shim exit code 0, `stdoutBytes=12621`
- Telegram message arrived (user confirmed)

## Next

- [ ] Leave the cron trigger alone — it fires tomorrow at 06:00 UTC
  (08:00 Europe/Zurich). That's the real first scheduled dispatch.
- [ ] After tomorrow's fire, verify the UI shows the run in
  `/routines/c6024a98-.../runs` with an `issue_created` status and
  a link to the LOB-N issue.
- [ ] Second routine to add: inbox triage (scan incoming issues
  every N minutes, assign/label/escalate). Same shape — routine
  description is the prompt, no pre-dispatch hook needed beyond
  stock routine variables.
- [ ] Start thinking about the approval queue UI tie-in. When
  routines start firing `paperclipCreateApproval`, the morning
  review needs a view that groups approvals by origin routine.
