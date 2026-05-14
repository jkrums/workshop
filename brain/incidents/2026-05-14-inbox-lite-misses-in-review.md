# Incident — paperclipInboxLite hid `in_review` issues from the woken agent

**Date:** 2026-05-14
**Surfaced by:** Lobbi GTM hire workflow on LOB-23
**Severity:** silent failure — agent stands down with "no actionable work"
**Fix:** [PR adding `in_review` to inbox-lite filter](server/src/routes/agents.ts)

## What happened

CEO was assigned LOB-23 (GTM hire). It drafted the hire config, posted a
`request_confirmation` interaction (id `e016211e-57a8-49ad-b112-917088d07e69`,
`continuationPolicy=wake_assignee`), and moved the issue to `in_review`.
Janis accepted the confirmation in the UI. The accept handler queued a
`wake_assignee` wake on CEO with the source issue's id in the context
snapshot — the wake itself was correct.

CEO woke, called `paperclipInboxLite`, got `[]`, called `paperclipMe`, got
its own config (no current issue). It stood down. Workaround: assign a new
explicit task (LOB-24) with the issue id inline.

## Root cause

The `wake_assignee` mechanism did its job. The accept handler in
`server/src/routes/issues.ts` calls
`queueResolvedInteractionContinuationWakeup`, which sets both
`payload.issueId` and `contextSnapshot.issueId` on the wake. The heartbeat
run is then queued with that snapshot, and `getIssueExecutionContext` resolves
the issue when the run executes.

The bug was downstream, in the agent's discovery path. The CEO's heartbeat
playbook (`server/src/onboarding-assets/ceo/HEARTBEAT.md`) tells it to fetch
`assigneeAgentId={your-id}&status=todo,in_progress,in_review,blocked` — so
`in_review` is part of the contract. But `paperclipInboxLite`'s hardcoded
filter was `status: "todo,in_progress,blocked"`. An agent calling the lite
endpoint to discover work never saw the `in_review` issue it had just put
itself there to wait on, and never knew it had been woken by a confirmation
accept.

The reporter's initial diagnosis — "wake_assignee drops the source issue
context" — was a reasonable hypothesis from the agent's side of the wall, but
the wake context itself was fine. The symptom was a missing status in the
discovery endpoint.

## Fix

Add `in_review` to the `paperclipInboxLite` status filter. One-line change,
brings the lite endpoint in line with the heartbeat docs.

```diff
- status: "todo,in_progress,blocked",
+ status: "todo,in_progress,in_review,blocked",
```

## Verification

After the fix lands and the worker image is rebuilt: CEO drafts on an issue,
posts `request_confirmation` with `wake_assignee`, accepts the confirmation
as a user, the wake fires, `paperclipInboxLite` returns the in_review issue,
agent picks it up and resumes work.

## Related

- PR #25 baked skills into the worker image so agents stop re-discovering
  contracts mid-task. The CEO heartbeat playbook is one of those baked-in
  files — its `in_review` instruction is now reachable, but only useful once
  the API endpoint actually returns those issues.
- See also `brain/ops/hour-11-log.md` for the recovery-loop $42 incident:
  another case where the agent didn't know what work it owned.
