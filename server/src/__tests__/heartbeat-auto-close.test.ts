import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat auto-close tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("heartbeat auto-close on run success", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-autoclose-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // TRUNCATE CASCADE avoids chasing every downstream table the heartbeat
    // service may have written to (runtime state, task sessions, skills, ...).
    await db.execute(
      sql`TRUNCATE TABLE activity_log, heartbeat_runs, agent_wakeup_requests, issues, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(opts: {
    runStatus: "succeeded" | "failed" | "cancelled" | "timed_out";
    issueStatus: "in_progress" | "todo" | "done";
    livenessState?: string | null;
    issueOwnsRun?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Atlas",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: opts.runStatus,
      contextSnapshot: { issueId },
      livenessState: opts.livenessState ?? null,
      startedAt: now,
      finishedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Self-close fixture",
      status: opts.issueStatus,
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: opts.issueOwnsRun === false ? null : runId,
      executionLockedAt: opts.issueOwnsRun === false ? null : now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, runId, issueId };
  }

  async function readIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
  }

  async function readRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("auto-closes an in_progress issue when its owning run succeeds", async () => {
    const { runId, issueId } = await seed({
      runStatus: "succeeded",
      issueStatus: "in_progress",
      livenessState: "completed",
    });
    const heartbeat = heartbeatService(db);
    const run = await readRun(runId);
    await heartbeat._testReleaseIssueExecutionAndPromote(run!);

    const after = await readIssue(issueId);
    expect(after?.status).toBe("done");
    expect(after?.executionRunId).toBeNull();

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity.some((row) => row.action === "issue.auto_closed_on_run_success")).toBe(true);
  });

  it("auto-closes when liveness is null (classifier didn't fire)", async () => {
    const { runId, issueId } = await seed({
      runStatus: "succeeded",
      issueStatus: "in_progress",
      livenessState: null,
    });
    const heartbeat = heartbeatService(db);
    const run = await readRun(runId);
    await heartbeat._testReleaseIssueExecutionAndPromote(run!);

    expect((await readIssue(issueId))?.status).toBe("done");
  });

  it("does NOT auto-close when liveness says continuation is needed", async () => {
    for (const livenessState of ["plan_only", "empty_response", "blocked", "needs_followup"]) {
      const { runId, issueId } = await seed({
        runStatus: "succeeded",
        issueStatus: "in_progress",
        livenessState,
      });
      const heartbeat = heartbeatService(db);
      const run = await readRun(runId);
      await heartbeat._testReleaseIssueExecutionAndPromote(run!);

      const after = await readIssue(issueId);
      expect(after?.status, `liveness=${livenessState} should keep issue open`).toBe("in_progress");
      expect(after?.executionRunId).toBeNull(); // execution lock still released

      await db.execute(
        sql`TRUNCATE TABLE activity_log, heartbeat_runs, agent_wakeup_requests, issues, agents, companies CASCADE`,
      );
    }
  });

  it("does NOT auto-close when the run failed", async () => {
    const { runId, issueId } = await seed({
      runStatus: "failed",
      issueStatus: "in_progress",
      livenessState: "completed",
    });
    const heartbeat = heartbeatService(db);
    const run = await readRun(runId);
    await heartbeat._testReleaseIssueExecutionAndPromote(run!);

    expect((await readIssue(issueId))?.status).toBe("in_progress");
  });

  it("does NOT auto-close when the issue executionRunId doesn't match", async () => {
    const { runId, issueId } = await seed({
      runStatus: "succeeded",
      issueStatus: "in_progress",
      livenessState: "completed",
      issueOwnsRun: false,
    });
    const heartbeat = heartbeatService(db);
    const run = await readRun(runId);
    await heartbeat._testReleaseIssueExecutionAndPromote(run!);

    // Issue was never owned by this run — no auto-close path.
    expect((await readIssue(issueId))?.status).toBe("in_progress");
  });
});
