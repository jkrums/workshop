---
type: ops
title: Hour 11 — Triage routes to Atlas, Minerva inert, and a $42 lesson
tags: [workshop, hour-11, routines, atlas, minerva, cost-safety, incident]
date: 2026-04-24
---

# Hour 11 — 2026-04-24 — Routing works, recovery loops bite

Hour 10 proved a second persona (Atlas) could stand on the same rails
as Hermes. Hour 11 was meant to be two clean things: upgrade the
triage routine so Hermes actually routes engineering work to Atlas,
and seed Minerva as a third persona (inert, no routing yet). Both got
done. Between them, an incident: a recovery-loop gotcha we had
already written down burned **$42 overnight**. The pattern is now a
hard rule in memory, both routines are paused, and the day pivots to
making cost-safety a first-class primitive in Workshop rather than a
prompt-hygiene footnote.

## Decisions

1. **Atlas is the only routable target for now.** Triage v2/v3 only
   knows one roster entry: Atlas for engineering-scope issues.
   Everything else stays on Janis's inbox. Expanding the roster
   (ops → Iris, analyst → Rory) waits until those personas exist.
2. **`paperclipInboxLite` is the wrong primitive for triage.** It
   returns the caller's own assignments, not the company inbox. The
   v2 prompt told Hermes to call it, so he saw only himself and
   routed zero issues. v3 swaps in `paperclipListIssues({status:"todo"})`
   with a client-side unassigned filter and skips routine-meta titles.
3. **Minerva ships inert.** One `INSERT INTO agents` with the
   reviewer persona, but no triage markers that would route to her
   yet. Review-routing activates when Atlas starts opening PRs — no
   point pre-wiring an empty pipe.
4. **Every prompt must self-close its own issue.** Hard rule saved
   as `feedback_routine_prompt_self_close.md`. The $42 burn proved
   this isn't a "nice to have" — it's a cost-safety gate.
5. **Pause > patch-and-pray after an incident.** With the rule known
   but unapplied across every seeded prompt, the safe move is to
   flip both `routine_triggers.enabled=false` until we land either a
   prompt-sweep or the upstream auto-close fix. Pausing is cheap;
   re-burning isn't.

## What was built

- **Triage v2 dispatched.** Routine description updated to add a
  route-to-Atlas pass with explicit engineering markers (`refactor`,
  `bug`, `fix`, `implement`, `test`, `migration`, `PR`, `TypeScript`,
  `build`), max 3 routings per run, Atlas's UUID hardcoded as the
  only recipient.
- **Triage v3 shipped.** Replaced `paperclipInboxLite` call with
  `paperclipListIssues({status:"todo"})`, added routine-meta title
  filter ("Inbox triage", "Daily briefing"), added explicit
  close-your-own-issue step at the end. Patched live via base64-SQL
  update to `public.routines.description`.
- **Minerva seeded.** Agent `b696e739-3f9e-4728-8d65-adff7a2dc4c6`,
  Lobbi company, `claude_remote` adapter, same
  `promptTemplate={{context.paperclipWake.issue.description}}` as
  Hermes and Atlas. `maxConcurrentRuns=2`. Inert until we wire
  review-routing.
- **Pre-dispatch hook still right-sized.** No new branches needed
  in `routine-dispatch-hooks.ts`. Both triage v2 and v3 use the same
  shared-variables helper (`buildCommonRoutineVariables`) landed in
  Hour 9.

## The $42 incident

Two parallel recovery loops ran for ~14 hours before Janis spotted
the spend:

| Agent  | Stuck issue | Cause | Runs | Cost |
|--------|-------------|-------|------|------|
| Atlas  | LOB-7 (refactor smoke) | Atlas persona has no self-close step | 147 | **$24.17** |
| Hermes | LOB-10 (daily briefing) | Briefing prompt has no self-close step | 94 | **$17.85** |

Both hit the exact pattern documented in `project_paperclip_routine_gotchas.md`
item #3: when an assigned agent exits without transitioning its own
issue out of `in_progress`, Paperclip's terminal-run-recovery keeps
re-dispatching the agent every ~60s. The triage v3 prompt had the
self-close step and behaved cleanly (LOB-11 closed itself); the
older daily-briefing prompt and the Atlas persona preamble did not.

Discovery, containment, memory:
1. Janis flagged rising spend.
2. Queried `heartbeat_runs` grouped by agent → saw 147 Atlas runs
   and 94 Hermes runs in a 14-hour window.
3. Closed LOB-7 and LOB-10 (`status=done`, clear `execution_run_id`).
4. Marked linked routine_runs `succeeded` / `completed_at`.
5. Waited for the two in-flight runs to drain → zero in-flight
   runs, zero `in_progress` issues.
6. Flipped `routine_triggers.enabled=false` on both Daily briefing
   (`c6024a98-...`) and Inbox triage (`e6af2841-...`). Next natural
   fire dates are frozen in `next_run_at` but won't dispatch.
7. Saved the hard rule as `feedback_routine_prompt_self_close.md`
   and updated `project_paperclip_routine_gotchas.md` with the cost
   entry. Indexed both in `MEMORY.md`.

Architecturally, nothing broke. The adapter, auth, MCP, worker
image, routing logic all worked. The failure was in prompt hygiene
at seeding time. This is exactly the class of problem Workshop-as-
control-plane is meant to *catch* — budget per agent, loop detection
on same-issue re-fires — not the class we pay for in cash.

## Lessons

- **The $42 was foreseeable.** Gotcha #3 was written in memory during
  Hour 10 after a $1 version of the same incident. The rule existed
  but wasn't mechanically enforced — it was advisory. Hard rules
  belong as feedback memories + tooling gates, not just project
  notes.
- **Cost-safety is product, not paperwork.** The next primitives on
  Workshop's roadmap are budget tripwires (per-agent $/hr cap that
  auto-pauses the agent and fires a Telegram approval) and loop
  detection (N re-fires on the same issue → auto-pause routine).
  These are first-class expressions of "Workshop is the control
  plane that protects humans from runaway agent spend."
- **Routines without self-close are unsafe by default.** Until
  either every seeded prompt is audited or Paperclip auto-closes
  on `heartbeat_run=succeeded`, any new routine is a potential
  burn source. Pause is the default state for new routines until
  verified.

## Next

- [ ] **Budget tripwires.** Per-agent `$/hr` and `$/day` caps on
  `agents` row. When a rolling window crosses threshold, set
  `status=paused` and fire a Telegram approval. Would have caught
  the $42 inside 30 minutes at ~$1/hr.
- [ ] **Loop detection.** If `heartbeat_runs` has N successful runs
  on the same `issue_id` within M minutes, auto-pause the routine
  and kick a Yellow approval. Root-cause interceptor, not just a
  cap.
- [ ] **Prompt sweep OR upstream fix.** Either audit all prompt
  templates to add self-close, or upstream a Paperclip patch that
  auto-transitions `issues.status='in_progress'→'done'` on
  `heartbeat_run=succeeded`. The upstream fix is cleaner; the
  sweep is faster.
- [ ] **Re-enable triggers after fix.** Both Daily briefing and
  Inbox triage are paused. Re-enable only after whichever fix
  lands — no partial resumption.
- [ ] **Atlas needs repo access to do real code work.** Next
  engineering task for Atlas requires git checkout inside the
  worker image (or a git-over-SSH path). Out of scope for Hour 11,
  on the to-Lobbi punch list.
