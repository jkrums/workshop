import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  heartbeatRuns,
  issues,
  routineRuns,
  routineTriggers,
} from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { buildLoopDetectedNotification, notifyTelegram } from "./telegram-notifications.js";

// If an agent completes >= `minRuns` successful heartbeat runs against the
// same issue inside `windowMinutes`, it is almost certainly stuck in a
// recovery / dispatch loop. We disable the driving routine triggers and kick
// a Yellow approval so a human can decide to resume, fix, or scrap.

export interface LoopDetectorOptions {
  windowMinutes?: number;
  minRuns?: number;
  now?: Date;
}

export interface DetectedLoop {
  companyId: string;
  agentId: string;
  issueId: string;
  runCount: number;
}

export interface LoopActionOutcome {
  loop: DetectedLoop;
  disabledTriggerIds: string[];
  approvalId: string | null;
  deduped: boolean;
}

export function loopDetectorService(db: Db) {
  async function detectSameIssueLoops(
    opts: LoopDetectorOptions = {},
  ): Promise<DetectedLoop[]> {
    const windowMinutes = opts.windowMinutes ?? 10;
    const minRuns = opts.minRuns ?? 3;
    const now = opts.now ?? new Date();
    const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000);

    const issueIdExpr = sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`;
    const rows = await db
      .select({
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        issueId: issueIdExpr,
        runCount: sql<number>`count(*)::int`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "succeeded"),
          gte(heartbeatRuns.finishedAt, windowStart),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' IS NOT NULL`,
        ),
      )
      .groupBy(heartbeatRuns.companyId, heartbeatRuns.agentId, issueIdExpr)
      .having(sql`count(*) >= ${minRuns}`);

    return rows.map((row) => ({
      companyId: row.companyId,
      agentId: row.agentId,
      issueId: row.issueId,
      runCount: row.runCount,
    }));
  }

  async function findDrivingTriggerIds(companyId: string, issueId: string): Promise<string[]> {
    const rows = await db
      .selectDistinct({ triggerId: routineRuns.triggerId })
      .from(routineRuns)
      .innerJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
      .where(
        and(
          eq(routineRuns.companyId, companyId),
          eq(routineRuns.linkedIssueId, issueId),
          eq(routineTriggers.enabled, true),
        ),
      );
    return rows
      .map((row) => row.triggerId)
      .filter((id): id is string => Boolean(id));
  }

  async function disableTriggers(triggerIds: string[]): Promise<void> {
    if (triggerIds.length === 0) return;
    const now = new Date();
    await db
      .update(routineTriggers)
      .set({
        enabled: false,
        lastResult: "paused_by_loop_detector",
        updatedAt: now,
      })
      .where(inArray(routineTriggers.id, triggerIds));
  }

  async function ensureLoopApproval(
    loop: DetectedLoop,
    disabledTriggerIds: string[],
  ): Promise<{ approvalId: string | null; deduped: boolean }> {
    // One pending approval per (company, issue) — don't spam every tick.
    const existing = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, loop.companyId),
          eq(approvals.type, "loop_detected"),
          eq(approvals.status, "pending"),
          sql`${approvals.payload}->>'issueId' = ${loop.issueId}`,
        ),
      );
    if (existing[0]) {
      return { approvalId: existing[0].id, deduped: true };
    }

    const [issue] = await db
      .select({ id: issues.id, title: issues.title, identifier: issues.identifier })
      .from(issues)
      .where(eq(issues.id, loop.issueId));
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.id, loop.agentId));

    const payload = {
      issueId: loop.issueId,
      issueIdentifier: issue?.identifier ?? null,
      issueTitle: issue?.title ?? null,
      agentId: loop.agentId,
      agentName: agent?.name ?? null,
      runCount: loop.runCount,
      disabledTriggerIds,
      guidance:
        "Routine triggers targeting this issue have been disabled. Review the issue, then re-enable the trigger or close the loop.",
    };

    const [created] = await db
      .insert(approvals)
      .values({
        companyId: loop.companyId,
        type: "loop_detected",
        requestedByUserId: null,
        requestedByAgentId: null,
        status: "pending",
        payload,
      })
      .returning();

    return { approvalId: created?.id ?? null, deduped: false };
  }

  async function actOnLoop(loop: DetectedLoop): Promise<LoopActionOutcome> {
    const triggerIds = await findDrivingTriggerIds(loop.companyId, loop.issueId);
    await disableTriggers(triggerIds);
    const { approvalId, deduped } = await ensureLoopApproval(loop, triggerIds);

    if (!deduped) {
      await logActivity(db, {
        companyId: loop.companyId,
        actorType: "system",
        actorId: "loop_detector",
        action: "routine.loop_detected",
        entityType: "issue",
        entityId: loop.issueId,
        details: {
          agentId: loop.agentId,
          runCount: loop.runCount,
          disabledTriggerIds: triggerIds,
          approvalId,
        },
      });

      // Look up names for the Telegram message; fall back to ids if missing.
      const [agent] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, loop.agentId));
      const [issue] = await db
        .select({ title: issues.title, identifier: issues.identifier })
        .from(issues)
        .where(eq(issues.id, loop.issueId));
      void notifyTelegram(
        buildLoopDetectedNotification({
          agentName: agent?.name ?? loop.agentId,
          issueLabel: issue?.identifier ?? issue?.title ?? loop.issueId,
          runCount: loop.runCount,
          disabledTriggerCount: triggerIds.length,
        }),
      ).catch(() => {});
    }

    return { loop, disabledTriggerIds: triggerIds, approvalId, deduped };
  }

  return {
    detectSameIssueLoops,
    actOnLoop,
    // Convenience wrapper: detect + act on every loop. Returns summary for logging.
    sweep: async (opts: LoopDetectorOptions = {}) => {
      const loops = await detectSameIssueLoops(opts);
      const outcomes: LoopActionOutcome[] = [];
      for (const loop of loops) {
        outcomes.push(await actOnLoop(loop));
      }
      const freshLoops = outcomes.filter((o) => !o.deduped).length;
      return {
        detected: loops.length,
        freshLoops,
        totalTriggersDisabled: outcomes.reduce((sum, o) => sum + o.disabledTriggerIds.length, 0),
      };
    },
  };
}

