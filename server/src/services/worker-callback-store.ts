// In-memory store for results pushed by remote workers (claude_remote adapter).
//
// Workers run in ephemeral Fly Machines and POST final results to
// /api/worker-callbacks/:runId/complete. The adapter polls /status until the
// completion arrives. Entries are auto-expired to bound memory.
//
// This is intentionally not persisted: if the control plane restarts mid-run,
// the adapter's poll times out and the run is marked failed — the next
// heartbeat will schedule a fresh attempt.

export interface WorkerRunCompletion {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  sessionParams: Record<string, unknown> | null;
  errorMessage: string | null;
  receivedAt: number;
}

const COMPLETION_TTL_MS = 15 * 60 * 1000; // 15 minutes

class WorkerCallbackStore {
  private completions = new Map<string, WorkerRunCompletion>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startSweep();
  }

  private startSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  private sweep() {
    const cutoff = Date.now() - COMPLETION_TTL_MS;
    for (const [runId, entry] of this.completions) {
      if (entry.receivedAt < cutoff) this.completions.delete(runId);
    }
  }

  putCompletion(entry: WorkerRunCompletion) {
    this.completions.set(entry.runId, entry);
  }

  getCompletion(runId: string): WorkerRunCompletion | null {
    return this.completions.get(runId) ?? null;
  }

  consumeCompletion(runId: string): WorkerRunCompletion | null {
    const entry = this.completions.get(runId) ?? null;
    if (entry) this.completions.delete(runId);
    return entry;
  }
}

export const workerCallbackStore = new WorkerCallbackStore();
