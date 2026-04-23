import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { parseClaudeStreamJson } from "@paperclipai/adapter-claude-local/server";
import { createMachine, destroyMachine, getMachine } from "./fly-machines.js";

interface RemoteExecutionConfig {
  flyApiToken: string;
  workerAppName: string;
  workerImage: string;
  workerRegion: string;
  workerMemoryMb: number;
  workerCpus: number;
  workerCpuKind: "shared" | "performance";
  anthropicApiKey: string;
  paperclipPublicUrl: string;
  model: string;
  extraArgs: string[];
  timeoutSec: number;
  pollIntervalMs: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`claude_remote: env ${name} is required but not set`);
  }
  return v.trim();
}

function resolveRemoteConfig(config: Record<string, unknown>): RemoteExecutionConfig {
  const workerAppName =
    asString(config.workerAppName, "") ||
    process.env.WORKSHOP_WORKER_APP ||
    "workshop-jkrums-workers";
  const workerImage =
    asString(config.workerImage, "") ||
    process.env.WORKSHOP_WORKER_IMAGE ||
    // Registry tag — resolves to the latest deploy of the worker app.
    `registry.fly.io/${workerAppName}:latest`;
  const workerRegion = asString(config.workerRegion, "") || process.env.WORKSHOP_WORKER_REGION || "iad";
  const workerMemoryMb = asNumber(config.workerMemoryMb, 512);
  const workerCpus = asNumber(config.workerCpus, 1);
  const workerCpuKindRaw = asString(config.workerCpuKind, "shared");
  const workerCpuKind: "shared" | "performance" =
    workerCpuKindRaw === "performance" ? "performance" : "shared";

  const paperclipPublicUrl =
    asString(config.paperclipPublicUrl, "") ||
    process.env.PAPERCLIP_PUBLIC_URL ||
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ||
    "";
  if (!paperclipPublicUrl) {
    throw new Error(
      "claude_remote: PAPERCLIP_PUBLIC_URL (or PAPERCLIP_AUTH_PUBLIC_BASE_URL) is required so workers can call back",
    );
  }

  return {
    flyApiToken: requireEnv("FLY_API_TOKEN"),
    workerAppName,
    workerImage,
    workerRegion,
    workerMemoryMb,
    workerCpus,
    workerCpuKind,
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    paperclipPublicUrl: paperclipPublicUrl.replace(/\/+$/, ""),
    model: asString(config.model, "claude-opus-4-7"),
    extraArgs: asStringArray(config.extraArgs),
    timeoutSec: asNumber(config.timeoutSec, 900),
    pollIntervalMs: Math.max(500, asNumber(config.pollIntervalMs, 2000)),
  };
}

function buildPrompt(ctx: AdapterExecutionContext): string {
  const promptTemplate = asString(
    ctx.config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  return renderTemplate(promptTemplate, {
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    company: { id: ctx.agent.companyId },
    agent: ctx.agent,
    run: { id: ctx.runId, source: "on_demand" },
    context: ctx.context,
  });
}

async function pollForCompletion(
  runId: string,
  cfg: RemoteExecutionConfig,
  authToken: string,
  deadline: number,
  onLog: AdapterExecutionContext["onLog"],
): Promise<
  | {
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
      errorMessage: string | null;
      sessionParams: Record<string, unknown> | null;
    }
  | null
> {
  const statusUrl = `${cfg.paperclipPublicUrl}/api/worker-callbacks/${encodeURIComponent(runId)}/status`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(statusUrl, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { status?: string; completion?: Record<string, unknown> }
          | null;
        if (body?.status === "complete" && body.completion) {
          const c = body.completion;
          return {
            exitCode: typeof c.exitCode === "number" ? c.exitCode : null,
            signal: typeof c.signal === "string" ? c.signal : null,
            timedOut: c.timedOut === true,
            stdout: typeof c.stdout === "string" ? c.stdout : "",
            stderr: typeof c.stderr === "string" ? c.stderr : "",
            errorMessage: typeof c.errorMessage === "string" ? c.errorMessage : null,
            sessionParams:
              c.sessionParams && typeof c.sessionParams === "object" && !Array.isArray(c.sessionParams)
                ? (c.sessionParams as Record<string, unknown>)
                : null,
          };
        }
      } else if (res.status !== 404) {
        await onLog(
          "stderr",
          `[claude_remote] callback status returned ${res.status}; will retry\n`,
        );
      }
    } catch (err) {
      await onLog(
        "stderr",
        `[claude_remote] callback poll error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs));
  }
  return null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta, authToken } = ctx;

  if (!authToken) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage:
        "claude_remote: authToken missing — the worker callback cannot be authenticated. Ensure the agent has a Paperclip API key.",
      errorCode: "missing_auth_token",
    };
  }

  let cfg: RemoteExecutionConfig;
  try {
    cfg = resolveRemoteConfig(parseObject(config));
  } catch (err) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "configuration_error",
    };
  }

  const prompt = buildPrompt(ctx);

  const workerEnv: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    // Override PAPERCLIP_API_URL so any Paperclip SDK / MCP tooling inside the
    // worker hits the public control plane rather than localhost.
    PAPERCLIP_API_URL: cfg.paperclipPublicUrl,
    PAPERCLIP_RUN_ID: runId,
    PAPERCLIP_API_KEY: authToken,
    PAPERCLIP_CALLBACK_URL: `${cfg.paperclipPublicUrl}/api/worker-callbacks/${encodeURIComponent(runId)}`,
    PAPERCLIP_PUBLIC_URL: cfg.paperclipPublicUrl,
    PAPERCLIP_WORKER_PROMPT: prompt,
    PAPERCLIP_WORKER_MODEL: cfg.model,
    ANTHROPIC_API_KEY: cfg.anthropicApiKey,
    ...(process.env.TELEGRAM_BOT_TOKEN
      ? { TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN }
      : {}),
    ...(process.env.TELEGRAM_CHAT_ID
      ? { TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID }
      : {}),
    ...(cfg.extraArgs.length > 0
      ? { PAPERCLIP_WORKER_EXTRA_ARGS: JSON.stringify(cfg.extraArgs) }
      : {}),
  };

  if (onMeta) {
    await onMeta({
      adapterType: "claude_remote",
      command: `fly-machine ${cfg.workerAppName}`,
      commandArgs: [cfg.workerImage],
      commandNotes: [
        `Worker app: ${cfg.workerAppName}`,
        `Region: ${cfg.workerRegion}`,
        `Memory: ${cfg.workerMemoryMb}MB`,
        `Callback URL: ${workerEnv.PAPERCLIP_CALLBACK_URL}`,
      ],
      env: {
        ...workerEnv,
        PAPERCLIP_API_KEY: "[redacted]",
        ANTHROPIC_API_KEY: "[redacted]",
        ...(workerEnv.TELEGRAM_BOT_TOKEN ? { TELEGRAM_BOT_TOKEN: "[redacted]" } : {}),
      },
      prompt,
      promptMetrics: { promptChars: prompt.length },
      context: ctx.context,
    });
  }

  await onLog(
    "stdout",
    `[claude_remote] spawning Fly Machine on ${cfg.workerAppName} (${cfg.workerRegion}) for run ${runId}\n`,
  );

  const machine = await createMachine({
    app: cfg.workerAppName,
    region: cfg.workerRegion,
    token: cfg.flyApiToken,
    name: `run-${runId.slice(0, 8)}-${Date.now().toString(36)}`,
    config: {
      image: cfg.workerImage,
      env: workerEnv,
      auto_destroy: true,
      restart: { policy: "no" },
      guest: {
        cpu_kind: cfg.workerCpuKind,
        cpus: cfg.workerCpus,
        memory_mb: cfg.workerMemoryMb,
      },
    },
  }).catch((err) => {
    return { error: err instanceof Error ? err.message : String(err) } as { error: string };
  });

  if ("error" in machine) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: `claude_remote: failed to create Fly Machine — ${machine.error}`,
      errorCode: "fly_create_failed",
    };
  }

  await onLog("stdout", `[claude_remote] machine ${machine.id} created (region=${machine.region})\n`);

  const deadline = Date.now() + cfg.timeoutSec * 1000;
  const completion = await pollForCompletion(runId, cfg, authToken, deadline, onLog);

  if (!completion) {
    // Timeout: best-effort destroy in case auto_destroy hasn't fired.
    await destroyMachine(cfg.workerAppName, machine.id, cfg.flyApiToken).catch(() => {});
    return {
      exitCode: null,
      signal: null,
      timedOut: true,
      errorMessage: `claude_remote: run ${runId} timed out after ${cfg.timeoutSec}s waiting for worker callback`,
      errorCode: "timeout",
    };
  }

  // Stream worker logs back to the heartbeat log for visibility.
  if (completion.stdout) await onLog("stdout", completion.stdout);
  if (completion.stderr) await onLog("stderr", completion.stderr);

  // Best-effort: machine should be auto-destroyed, but clean up on error paths.
  if (completion.exitCode !== 0) {
    try {
      const status = await getMachine(cfg.workerAppName, machine.id, cfg.flyApiToken);
      if (status.state !== "destroyed" && status.state !== "destroying") {
        await destroyMachine(cfg.workerAppName, machine.id, cfg.flyApiToken).catch(() => {});
      }
    } catch {
      // ignore — machine may already be gone.
    }
  }

  const parsedStream = parseClaudeStreamJson(completion.stdout);
  const parsed = parsedStream.resultJson;

  if (!parsed) {
    return {
      exitCode: completion.exitCode,
      signal: completion.signal,
      timedOut: completion.timedOut,
      errorMessage:
        completion.errorMessage ??
        (completion.exitCode === 0
          ? "claude_remote: worker exited cleanly but produced no parseable result"
          : `claude_remote: worker exited ${completion.exitCode}`),
      errorCode: completion.exitCode === 0 ? "unparseable_output" : "worker_failed",
      resultJson: {
        workerStdoutBytes: completion.stdout.length,
        workerStderrBytes: completion.stderr.length,
      },
    };
  }

  const sessionParams = parsedStream.sessionId
    ? ({ sessionId: parsedStream.sessionId } as Record<string, unknown>)
    : null;

  return {
    exitCode: completion.exitCode,
    signal: completion.signal,
    timedOut: false,
    usage: parsedStream.usage ?? undefined,
    sessionId: parsedStream.sessionId,
    sessionParams,
    sessionDisplayId: parsedStream.sessionId,
    model: parsedStream.model || cfg.model,
    costUsd: parsedStream.costUsd,
    resultJson: parsed,
    summary: parsedStream.summary,
    billingType: "api",
    provider: "anthropic",
  };
}
