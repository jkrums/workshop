import { beforeEach, describe, expect, it, vi } from "vitest";
import { loopDetectorService } from "../services/loop-detector.ts";
import { buildLoopDetectedNotification } from "../services/telegram-notifications.ts";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pending = [...selectResults];
  const nextResult = async () => pending.shift() ?? [];

  const terminalOp = vi.fn(nextResult);
  const chain: Record<string, unknown> = {};
  chain.where = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.having = terminalOp;
  chain.from = vi.fn(() => chain);
  chain.then = vi.fn((resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(resolve(pending.shift() ?? [])),
  );
  // when no having/groupBy chain follows, treat `.where` result as awaitable
  const whereAwaitable = new Proxy(chain, {
    get(target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown[]) => unknown) =>
          Promise.resolve(resolve(pending.shift() ?? []));
      }
      return target[prop as string];
    },
  });
  chain.where = vi.fn(() => whereAwaitable);

  const select = vi.fn(() => chain);
  const selectDistinct = vi.fn(() => chain);

  const insertValues = vi.fn();
  const insertReturning = vi.fn(async () => pendingInserts.shift() ?? []);
  const insert = vi.fn(() => ({
    values: insertValues.mockImplementation(() => ({ returning: insertReturning })),
  }));

  const updateSet = vi.fn();
  const updateWhere = vi.fn(async () => []);
  const update = vi.fn(() => ({
    set: updateSet.mockImplementation(() => ({ where: updateWhere })),
  }));

  const pendingInserts: unknown[][] = [];

  return {
    db: { select, selectDistinct, insert, update },
    queueInsert: (rows: unknown[]) => pendingInserts.push(rows),
    insertValues,
    updateSet,
  };
}

describe("loopDetectorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("actOnLoop disables driving triggers and creates a fresh approval", async () => {
    const dbStub = createDbStub([
      [{ triggerId: "trigger-1" }, { triggerId: "trigger-2" }], // findDrivingTriggerIds
      [], // ensureLoopApproval dedup select — none pending
      [{ id: "issue-1", title: "Cost check", identifier: "LOB-42" }], // issue lookup for payload
      [{ id: "agent-1", name: "Atlas" }], // agent lookup for payload
      [{ name: "Atlas" }], // agent lookup for telegram
      [{ title: "Cost check", identifier: "LOB-42" }], // issue lookup for telegram
    ]);
    dbStub.queueInsert([{ id: "approval-1", status: "pending" }]);

    const service = loopDetectorService(dbStub.db as any);
    const outcome = await service.actOnLoop({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      runCount: 4,
    });

    expect(outcome.deduped).toBe(false);
    expect(outcome.disabledTriggerIds).toEqual(["trigger-1", "trigger-2"]);
    expect(outcome.approvalId).toBe("approval-1");
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        lastResult: "paused_by_loop_detector",
      }),
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        type: "loop_detected",
        status: "pending",
        payload: expect.objectContaining({
          issueId: "issue-1",
          agentId: "agent-1",
          runCount: 4,
          disabledTriggerIds: ["trigger-1", "trigger-2"],
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "routine.loop_detected",
        entityId: "issue-1",
      }),
    );
  });

  it("actOnLoop dedupes when a pending approval already exists", async () => {
    const dbStub = createDbStub([
      [{ triggerId: "trigger-1" }], // findDrivingTriggerIds
      [{ id: "approval-existing" }], // ensureLoopApproval dedup — already pending
    ]);

    const service = loopDetectorService(dbStub.db as any);
    const outcome = await service.actOnLoop({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      runCount: 5,
    });

    expect(outcome.deduped).toBe(true);
    expect(outcome.approvalId).toBe("approval-existing");
    // No new approval inserted; no activity logged for dedup path.
    expect(dbStub.insertValues).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

describe("buildLoopDetectedNotification", () => {
  it("formats a Telegram message mentioning the issue and disabled trigger count", () => {
    const text = buildLoopDetectedNotification({
      agentName: "Atlas",
      issueLabel: "LOB-42",
      runCount: 4,
      disabledTriggerCount: 2,
    });
    expect(text).toContain("Same-issue loop detected");
    expect(text).toContain("Atlas");
    expect(text).toContain("LOB-42");
    expect(text).toContain("4 successful runs");
    expect(text).toContain("2 routine triggers");
  });

  it("singular trigger copy when only one trigger disabled", () => {
    const text = buildLoopDetectedNotification({
      agentName: "Atlas",
      issueLabel: "LOB-1",
      runCount: 3,
      disabledTriggerCount: 1,
    });
    expect(text).toContain("1 routine trigger auto-disabled");
  });
});
