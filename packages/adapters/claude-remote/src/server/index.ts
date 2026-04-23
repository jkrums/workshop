import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterSessionCodec,
} from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];

  const flyToken = process.env.FLY_API_TOKEN;
  if (flyToken && flyToken.trim().length > 0) {
    checks.push({
      code: "claude_remote_fly_token_present",
      level: "info",
      message: "FLY_API_TOKEN is set; Fly Machines API calls can be authenticated.",
    });
  } else {
    checks.push({
      code: "claude_remote_fly_token_missing",
      level: "error",
      message: "FLY_API_TOKEN is not set.",
      hint: "Set FLY_API_TOKEN on the control plane (flyctl secrets set FLY_API_TOKEN=...).",
    });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && anthropicKey.trim().length > 0) {
    checks.push({
      code: "claude_remote_anthropic_key_present",
      level: "info",
      message: "ANTHROPIC_API_KEY is set; workers will use API-key billing.",
    });
  } else {
    checks.push({
      code: "claude_remote_anthropic_key_missing",
      level: "error",
      message: "ANTHROPIC_API_KEY is not set.",
      hint: "Set ANTHROPIC_API_KEY on the control plane; it is forwarded to each worker.",
    });
  }

  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL || process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL;
  if (publicUrl && publicUrl.trim().length > 0) {
    checks.push({
      code: "claude_remote_callback_url_present",
      level: "info",
      message: `Worker callback base URL resolved to ${publicUrl}.`,
    });
  } else {
    checks.push({
      code: "claude_remote_callback_url_missing",
      level: "error",
      message: "PAPERCLIP_PUBLIC_URL (or PAPERCLIP_AUTH_PUBLIC_BASE_URL) is not set.",
      hint: "Set PAPERCLIP_PUBLIC_URL so workers can POST results back to the control plane.",
    });
  }

  const status: AdapterEnvironmentTestResult["status"] = checks.some((c) => c.level === "error")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}

// Session resumption is not supported in the H5 MVP: each run spawns a fresh
// machine, so there is no persistent session to resume. We still provide a
// codec that preserves the Anthropic sessionId for UI display.
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const sessionId = (raw as Record<string, unknown>).sessionId;
    return typeof sessionId === "string" && sessionId.trim().length > 0
      ? { sessionId: sessionId.trim() }
      : null;
  },
  serialize(params) {
    if (!params) return null;
    const sessionId = params.sessionId;
    return typeof sessionId === "string" && sessionId.trim().length > 0
      ? { sessionId: sessionId.trim() }
      : null;
  },
  getDisplayId(params) {
    if (!params) return null;
    const sessionId = params.sessionId;
    return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : null;
  },
};
