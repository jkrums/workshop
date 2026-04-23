import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { UIAdapterModule } from "../types";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { ClaudeRemoteConfigFields } from "./config-fields";

function buildClaudeRemoteConfig(values: CreateConfigValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const schema = values.adapterSchemaValues ?? {};
  if (typeof schema.workerAppName === "string" && schema.workerAppName.trim()) {
    out.workerAppName = schema.workerAppName.trim();
  }
  if (typeof schema.workerRegion === "string" && schema.workerRegion.trim()) {
    out.workerRegion = schema.workerRegion.trim();
  }
  if (typeof schema.timeoutSec === "number" && schema.timeoutSec > 0) {
    out.timeoutSec = schema.timeoutSec;
  }
  return out;
}

export const claudeRemoteUIAdapter: UIAdapterModule = {
  type: "claude_remote",
  label: "Claude Code (remote — Fly Machines)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeRemoteConfigFields,
  buildAdapterConfig: buildClaudeRemoteConfig,
};
