---
type: ops
title: Hour 10 — Atlas joins the roster
tags: [workshop, hour-10, personas, atlas, routing]
date: 2026-04-23
---

# Hour 10 — 2026-04-23 — Second persona on the same rails

Hours 7–9 built and validated the routine primitive with one agent
(Hermes). Hour 10 proves the persona layer scales: a second agent
(Atlas) on the same adapter, same worker image, same MCP surface,
different identity and scope. Also the first moment where routing
becomes meaningful — Hermes's triage can now actually route code
work to someone.

## Decisions

1. **JWT-per-run, not API-key-per-agent.** `claude_remote`'s
   `authToken` is minted by `createLocalAgentJwt(agent.id, ...)` at
   dispatch time inside `heartbeat.ts`. Adding Atlas required zero
   key provisioning, zero secret rotation, zero Fly secrets. One
   `INSERT INTO agents` and the run works. This is the right design —
   scales to any number of personas without secret sprawl.
2. **Persona inline in issue description (for now).** Same pattern
   as the routine prompts: the issue description IS the prompt, so
   Atlas's persona preamble is just pasted at the top. Clean contract
   (adapter `promptTemplate` is still `{{context.paperclipWake.issue.description}}`),
   but it means whoever creates the issue has to paste the right
   persona. Future: a "persona" column on `agents` + a hook that
   prepends it at render time. Wait until we feel the pain.
3. **Smoke test = identity verification, not code work.** Drafted two
   alternatives: (a) give Atlas a real engineering task against the
   Workshop repo, (b) a pure identity/introspection test. Picked (b)
   because the worker image has no git/repo mount, and the first run
   of any new persona should prove the routing loop before adding
   code-write surface. Atlas did: `paperclipMe` → `paperclipInboxLite`
   → `paperclipAddComment`. Three-line self-intro was exactly the
   right scope.
4. **Defer the "blocked" recovery quirk.** Paperclip auto-marks
   `in_progress` issues with a `blocked` system comment when a run
   fails with `adapter_failed`. A subsequent successful run does NOT
   clear that marker. The smoke test retry caught this. Decision:
   log and move on — it's upstream code, the fix is non-trivial,
   and the cost (one stale comment) is low. Revisit when we have
   either a few accumulated or are ready to PR upstream.

## What was built

- **Seeded Atlas agent.** Base64-encoded SQL INSERT via `flyctl ssh`
  → psql. ID `3d66fe1c-da6d-452e-9346-64579ae3fa87`, Lobbi company,
  adapter `claude_remote`, same adapter_config as Hermes
  (`timeoutSec=600`, `promptTemplate={{context.paperclipWake.issue.description}}`).
  Runtime config: `maxConcurrentRuns=3` (vs. Hermes's 5 — Atlas
  does heavier, slower work).
- **Created LOB-6** via UI with Atlas persona preamble + identity
  smoke-test task. Assignment fired
  `queueIssueAssignmentWakeup` → heartbeat → `claude_remote`
  adapter → Fly machine spawn → Atlas run.

## Smoke test — the full trajectory

Three runs, same issue:

| Run | Started | Result | Exit | Cost | Notes |
|-----|---------|--------|------|------|-------|
| `fd4f93d2` | 15:27:46 | failed | 1 | $0.0014 | Anthropic 529 Overloaded |
| `1406e7f5` | 15:28:48 | failed | 1 | ~$0 | 529 again; auto-retry on blocked issue |
| `f6b6103c` | 15:31:44 | succeeded | 0 | $0.29 | 8 turns, 34s API, 1668 out tokens |

The capacity failures were instructive:
- The adapter spawn worked on attempt 1 (`[claude_remote] machine
  9185d622a26e83 created`), MCP connected with all paperclip tools
  (`mcp_servers: [{name: paperclip, status: connected}]`), JWT auth
  validated. The failure was purely the model API returning 529.
- Paperclip's terminal-run recovery fired after the first failure,
  adding a system comment ("Moving it to `blocked` so it is visible
  for intervention") and scheduling an auto-retry. That retry also
  529'd. The third attempt — triggered by Janis manually releasing
  the execution lock via SQL and reassigning — succeeded.
- **Architecturally**: routing + adapter + auth + MCP all validated.
  **Externally**: Anthropic capacity matters; transient 529s will
  happen; the recovery logic works but leaves stale markers.

Atlas's final comment (verbatim):
> Atlas — company `884542b5-7277-438b-bb71-da227ee4721c`
> Inbox has 1 item (LOB-6, this smoke test); no other issues
> currently in engineering scope.
> I own feature implementation, bug fixes, refactors, tests, and CI
> hygiene on assigned issues — I do not own routing/triage (Hermes)
> or code review (Minerva).

Persona correctly understood. Scope boundaries correctly cited.
One `paperclipMe` call, one `paperclipInboxLite`, one
`paperclipAddComment` — exact bounds respected.

## What this unlocks

- **Triage routine becomes real.** Hermes's every-hour inbox scan
  can now actually route code-tagged issues to Atlas — something
  to escalate beyond Telegram. The v1 triage prompt is still
  read-and-escalate-only; the v2 version (with routing mutations)
  is now justified because there's somewhere to route TO.
- **Approvals UI story.** Atlas is the first persona that will
  realistically generate `paperclipCreateApproval` calls (PR merge,
  dependency install, migration). That's the signal that justifies
  the approval-queue grouping work scoped in Hour 9.
- **Third persona is a 5-minute task.** Minerva (reviewer), Iris
  (ops), Rory (analyst) are all INSERT-and-go from here. The
  persona layer is now proven.

## Follow-ups

- [ ] **LOB-6 stale "blocked" comment.** Known quirk — successful
  run after a failed one doesn't clear the system recovery comment.
  Upstream Paperclip surface; track as known-issue, revisit when we
  decide to PR to Cathryn or patch locally.
- [ ] **Atlas code-work smoke test.** The identity test proved
  routing. Next real test: give Atlas a PR-drafting issue against
  the Workshop repo itself. Requires: repo checkout inside worker
  image OR a git-over-SSH path OR hand-rolling the diff from
  issue content. Scope this in Hour 11+.
- [ ] **Persona column on `agents`.** When we add persona #3 we'll
  feel the "copy-paste the preamble every time" tax. Pre-emptive
  mitigation: a `personaTemplate` column or an agent-level
  `promptTemplate` that prepends persona automatically. Wait for
  the second pain point before building.
- [ ] **Issue terminology.** `queueIssueAssignmentWakeup` fires on
  assignment *event*, not DB state change. Releasing via SQL + then
  reassigning via UI was the working retry recipe — worth documenting
  if we build a "rerun" button.
