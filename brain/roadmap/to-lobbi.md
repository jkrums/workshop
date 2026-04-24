---
type: roadmap
title: From Workshop-as-scaffold to Lobbi-actually-runs
tags: [roadmap, lobbi, milestones]
date: 2026-04-24
---

# To-Lobbi punch list

What stands between today (Workshop infra proven with three inert-
to-routing personas) and "Lobbi's product work flows through
Workshop daily." One entry per milestone. Closing all of these is
the trigger to declare Workshop ready for real tenant use.

Keep this file short. Sub-plans live in their own brain pages or
GitHub issues linked below.

---

## 1. Cost-safety primitives

**Why it's the gate:** until runaway agent spend is caught inside
minutes, no new routine is safe to enable. See
[`hour-11-log.md`](../ops/hour-11-log.md) — $42 in 14 hours from two
parallel recovery loops.

- [ ] **Per-agent budget tripwire.** New columns on `agents`:
  `budget_per_hour_usd`, `budget_per_day_usd`. Background job sums
  `heartbeat_runs.result_json.total_cost_usd` on a rolling window.
  On breach: set `agents.status='paused'`, fire Telegram approval.
- [ ] **Same-issue loop detector.** If ≥ N successful heartbeat
  runs on the same `issue_id` within M minutes, auto-pause the
  routine (`routine_triggers.enabled=false`) and kick Yellow
  approval. Defaults: N=3, M=10.
- [ ] **Global kill switch.** One-toggle env flag or UI button that
  flips all `routine_triggers.enabled=false` in one shot. Incident-
  response muscle.

## 2. Self-close fix (prompt-level or upstream)

**Why it's required:** even with tripwires, the fix for the root
cause of the $42 burn is either audit every prompt template or
patch Paperclip itself.

- [ ] **Option A (fast):** sweep all seeded prompts + persona
  templates. Add `paperclipUpdateIssue status="done"` closing step
  to: Daily briefing description, Atlas persona preamble, Minerva
  persona preamble, any future seed. Triage v3 already has it.
- [ ] **Option B (clean):** upstream patch to Paperclip — when
  `heartbeat_runs.status='succeeded'` and the run's `issue_id` is
  still `in_progress` with matching `execution_run_id`, auto-
  transition the issue to `done`. Talk to Cathryn.

Pick one. B is the right design; A unblocks sooner. If doing A,
track which prompts are audited in this checklist so we don't
miss one.

## 3. Atlas does real code work

**Why it's the bar:** identity-smoke is done. Next is shipping a
PR against `jkrums/lobbi` or `jkrums/workshop`.

- [ ] **Repo checkout path in worker image.** Pick one: (a) bake
  git + SSH key mount into the `workshop-jkrums-workers` image,
  (b) git-over-HTTPS with a fine-grained PAT, (c) hand-roll diffs
  from issue content and POST via GitHub API.
- [ ] **First real Atlas PR.** End-to-end: Hermes triage routes
  an engineering issue → Atlas checks out → edits → tests →
  commits → opens PR → Minerva gets routing signal.
- [ ] **PR-merge approval.** Any Atlas PR merge flows through
  `paperclipCreateApproval` → Telegram → Janis. Red authority
  per `operating-principles.md`.

## 4. Minerva activates

**Why it's next:** review is the obvious gate before merging
anything Atlas ships.

- [ ] **Routing signal.** Triage prompt learns "if the issue is
  `type=code-review` or comment mentions `@minerva`, route to
  Minerva instead of (or in addition to) Atlas."
- [ ] **Review smoke test.** Minerva reads a small Atlas PR and
  posts a review comment. Same inert→active pattern as Atlas.

## 5. Approval queue UI

**Why it's needed:** when routines fire `paperclipCreateApproval`,
Janis shouldn't get 30 separate Telegram pings. Morning review
needs a grouped view. Originally scoped in Hour 9.

- [ ] **Group by origin routine** in `/approvals` page.
- [ ] **Morning digest card:** one Telegram message per day at
  07:30 Europe/Zurich with all pending approvals grouped by
  agent + priority.

## 6. First real Lobbi work

**Why it's the finish line:** the point of Workshop is to run
Lobbi (and future tenants). Everything above is scaffolding until
a Lobbi-product issue flows through the full pipeline.

- [ ] **Seed a Lobbi-tenant agent.** Not Hermes/Atlas/Minerva
  (those are Workshop-meta). A Lobbi-product persona that reads
  from the Lobbi repo and writes product code.
- [ ] **First Lobbi issue end-to-end.** Human files issue in
  Workshop → triage → Lobbi agent → PR → review → merge →
  issue closed. All on autopilot except merge approval.
- [ ] **Declare readiness.** If steps 1–6 are green, Workshop is
  ready for "Lobbi actually runs." Pause, retrospective, move
  Hour-N clock to weekly-ops clock.

---

## What's NOT on this list on purpose

- Deep rebrand of internal `PAPERCLIP_*` identifiers (deferred —
  costs upstream merges, pays zero value).
- Second tenant (Lobbi Card, personal projects). Don't multi-
  tenant until single-tenant works.
- CrabTrap security gateway. Parked for now — budget tripwires +
  approval queue cover most of the same territory for MVP.

---

*Update this file when a box closes. When all six milestones are
green, archive to `brain/concepts/` as a historical record and
start a new roadmap.*
