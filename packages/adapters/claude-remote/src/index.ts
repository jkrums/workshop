export const type = "claude_remote";
export const label = "Claude Code (remote — Fly Machines)";

// Reuse the model catalog from claude-local — same Anthropic SDK under the hood.
export { models } from "@paperclipai/adapter-claude-local";

export const agentConfigurationDoc = `# claude_remote agent configuration

Adapter: claude_remote

Spawns an ephemeral Fly Machine per run, runs \`claude\` inside it, and returns
the result. Used on the Workshop control plane (Fly-deployed) where no local
\`claude\` CLI is available and per-run isolation is desired.

Required control-plane env:
- FLY_API_TOKEN            — Fly API token with access to the worker app
- WORKSHOP_WORKER_APP      — Fly app name hosting the worker image (default: workshop-jkrums-workers)
- PAPERCLIP_PUBLIC_URL     — base URL workers call back to (e.g. https://workshop-jkrums.fly.dev)
- ANTHROPIC_API_KEY        — forwarded to each worker

Core fields:
- model (string, optional): Claude model id (defaults to claude-opus-4-7)
- extraArgs (string[], optional): additional \`claude\` CLI args
- timeoutSec (number, optional): adapter-side poll timeout (default 900 = 15min)
- pollIntervalMs (number, optional): worker completion poll interval (default 2000)
- workerAppName (string, optional): override WORKSHOP_WORKER_APP
- workerRegion (string, optional): Fly region (default iad)
- workerMemoryMb (number, optional): machine memory (default 512)
- workerCpuKind (string, optional): shared | performance (default shared)
- workerCpus (number, optional): vCPU count (default 1)

The worker image contract is defined in \`worker/shim.mjs\`. Env passed to each
machine: PAPERCLIP_WORKER_PROMPT, PAPERCLIP_WORKER_MODEL, PAPERCLIP_RUN_ID,
PAPERCLIP_CALLBACK_URL, PAPERCLIP_API_KEY, ANTHROPIC_API_KEY.
`;
