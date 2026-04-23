---
type: ops
title: Hour 9 — Inbox triage as the second routine
tags: [workshop, hour-9, routines, hermes, inbox-triage]
date: 2026-04-23
---

# Hour 9 — 2026-04-23 — Second routine lands on the same rails

Hour 8 seated the daily briefing in `routines` + `routine_triggers`.
Hour 9 proves the pattern extends: a second routine (`Inbox triage`)
riding the same dispatch path, same adapter, same worker image,
same MCP tools. Only additions: one more branch in
`buildPreDispatchVariables`, one more env var, one more routine row.
No new infrastructure.

This is the test of whether routines-as-unified-primitive actually
holds. It does.

## Decisions

1. **Triage is read-and-escalate, not read-and-mutate.** Draft had
   Hermes self-assigning, commenting, closing stale issues. Cut all
   of that. For a 16x/day routine, the blast radius of "agent mutates
   issues unprompted" is too wide while we still have one persona.
   Triage v1 is: scan inbox, decide if anything clears the bar,
   Telegram at most three items, otherwise stay silent. Mutations
   come back when there are other personas to route to.
2. **Silence is the correct default.** Prompt explicitly says: if
   nothing clears the bar, do NOT POST to Telegram. A routine that
   fires 16 times a day cannot cry wolf — one false-positive ping
   and Janis starts muting the channel. Build trust by staying
   quiet until something actually matters.
3. **High escalation bar, concrete predicates.** Three OR'd rules:
   `priority=urgent` AND zero comments; approval `pending > 6h`;
   recent comment (last 2h) directly tagging Janis. No vague "use
   judgment" — the prompt enumerates what qualifies. Easier to
   debug false positives later because every flag maps to one rule.
4. **Hourly, working-hours only.** Cron `0 7-22 * * *` Europe/Zurich
   = 16 runs/day. At ~$0.20/run (briefing reference cost) that's
   ~$3.20/day. Could go half-hourly (32 runs) but the marginal
   signal isn't worth 2x the cost while the bar is this high.
5. **Shared-variables helper, not a registry (yet).** Refactored
   `routine-dispatch-hooks.ts` to extract `buildCommonRoutineVariables`
   (persona, date_label, workshop_url). Briefing adds counts on top;
   triage uses just the commons. Still two branches, still
   env-var-keyed. Registry promotion waits for a third hook kind —
   same reasoning as Hour 8, no premature abstraction.

## What was built

- **Refactored `routine-dispatch-hooks.ts`.** New
  `buildCommonRoutineVariables()` returns `{persona, date_label,
  workshop_url}`. `buildDailyBriefingVariables()` awaits it in
  `Promise.all` with `gatherBriefingCounts()` and spreads both.
  New `WORKSHOP_INBOX_TRIAGE_ROUTINE_ID` branch returns just the
  commons. PR #13, merged.
- **Seeded triage routine + trigger on prod.** Base64-encoded
  dollar-quoted SQL transaction via `flyctl ssh` → psql. Routine
  `e6af2841-29e4-4495-a8df-12a5cf747770`, Lobbi company, Hermes
  assignee, priority `medium`, status `active`, concurrency
  `coalesce_if_active`, catch-up `skip_missed`. Trigger kind
  `schedule`, cron `0 7-22 * * *`, timezone `Europe/Zurich`,
  `next_run_at` set to 2026-04-24 05:00 UTC so the first natural
  fire is tomorrow 07:00 Geneva (today's smoke test is
  manual-only).
- **Set env var on Fly.** `flyctl secrets set
  WORKSHOP_INBOX_TRIAGE_ROUTINE_ID=e6af2841-...` triggered the
  rolling restart. Machine `7813239c2d0e98` came back healthy on
  deployment `01KPXDJ98Y`.

## Triage prompt shape

Same interpolation contract as briefing — the routine's `description`
is the prompt template. Variables: `{{persona}}`, `{{date_label}}`,
`{{workshop_url}}`. The prompt structure:

1. Persona preamble
2. "It is **{{date_label}}** — intraday triage sweep" framing
3. Procedure: one `paperclipInboxLite` call, apply escalation rules,
   silent no-op OR one Telegram POST summarising ≤3 items
4. Bounds: one inbox call, no per-item reads, no mutations
5. Telegram format (urgent prefix, bullet list)
6. Exit confirmation

## Smoke test

(pending — Janis to click Run now on `/routines` → Inbox triage)

## Next

- [ ] Once triage smoke passes, verify both routines' runs show up
  side-by-side in the UI with clean status transitions.
- [ ] Approval-queue UI: the morning review view needs to group
  approvals by origin routine. Currently `approvals` don't carry a
  `routine_id`, so the grouping either has to follow
  `origin_issue.origin_run.routine_id`, or we denormalise. Decide
  before shipping the view.
- [ ] Third routine candidate: **weekly review**, Sunday 18:00
  Geneva. Same shape, adds `buildWeeklyReviewVariables` with
  week-over-week deltas from heartbeat_runs + approvals + issues.
  This will be the third hook kind — time to promote
  env-var-keyed-switch to `routines.dispatch_hook` column.
- [ ] Atlas persona as second agent. Triage currently self-assigns
  to Hermes because there's no one else. With a code-working Atlas,
  triage can route issues tagged `code` to Atlas while keeping ops
  work with Hermes — makes the "routing" part of triage real.
