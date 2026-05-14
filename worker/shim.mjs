#!/usr/bin/env node
// Workshop remote worker shim.
//
// Runs inside an ephemeral Fly Machine spawned by the claude_remote adapter.
// Reads prompt + auth from env, runs `claude` non-interactively, buffers
// stdout/stderr, then POSTs the final result back to the control plane so
// the adapter (which is polling) can return it to the heartbeat service.
//
// Env contract (set per-spawn by claude_remote/src/server/execute.ts):
//   PAPERCLIP_WORKER_PROMPT      — prompt text (required)
//   PAPERCLIP_WORKER_MODEL       — optional model id
//   PAPERCLIP_WORKER_EXTRA_ARGS  — optional JSON array of extra claude args
//   PAPERCLIP_CALLBACK_URL       — base URL for worker-callback endpoints
//   PAPERCLIP_RUN_ID             — run id (for log correlation)
//   PAPERCLIP_API_KEY            — agent API key for callback auth
//   ANTHROPIC_API_KEY            — claude billing key

import { spawn } from "node:child_process";

async function failFast(message) {
  // The adapter polls /worker-callbacks/:runId/status until either /complete
  // arrives or its timeoutSec expires. If the shim just process.exit()s, the
  // adapter has no signal and burns the full polling window (10+ min). When
  // we can identify a fatal-before-claude condition, post a synthetic
  // completion so the adapter returns immediately and the recovery loop sees
  // a real error instead of an opaque timeout.
  console.error(`[shim] ${message}`);
  const callbackUrl = process.env.PAPERCLIP_CALLBACK_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (callbackUrl && apiKey) {
    await postCallback(callbackUrl, apiKey, {
      exitCode: 2,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: message,
      errorMessage: message,
    }).catch(() => {});
  }
  process.exit(2);
}

async function req(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    await failFast(`missing required env ${name}`);
  }
  return v;
}

function parseArgs() {
  const raw = process.env.PAPERCLIP_WORKER_EXTRA_ARGS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    console.error("[shim] PAPERCLIP_WORKER_EXTRA_ARGS is not valid JSON array, ignoring");
    return [];
  }
}

async function postCallback(callbackUrl, apiKey, payload) {
  const url = `${callbackUrl.replace(/\/+$/, "")}/complete`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
      console.error(`[shim] callback POST attempt ${attempt + 1} returned ${res.status}`);
    } catch (err) {
      console.error(
        `[shim] callback POST attempt ${attempt + 1} error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return false;
}

async function main() {
  // Resolve callback URL + API key first so failFast can phone home if any of
  // the other required envs are missing.
  const callbackUrl = await req("PAPERCLIP_CALLBACK_URL");
  const apiKey = await req("PAPERCLIP_API_KEY");
  const prompt = await req("PAPERCLIP_WORKER_PROMPT");
  await req("ANTHROPIC_API_KEY");
  const runId = process.env.PAPERCLIP_RUN_ID ?? "(no run id)";
  const model = process.env.PAPERCLIP_WORKER_MODEL?.trim();
  const extraArgs = parseArgs();

  console.log(`[shim] workshop-worker starting run=${runId} model=${model ?? "(default)"}`);

  // Wire the bundled Paperclip MCP stdio server into this invocation.
  // Env for the child MCP is inherited from process.env (PAPERCLIP_API_URL
  // + PAPERCLIP_API_KEY already set by the adapter) plus PAPERCLIP_RUN_ID
  // so mutations carry the run id header.
  const mcpServerPath =
    process.env.PAPERCLIP_MCP_SERVER_PATH ?? "/worker/mcp/paperclip-mcp-server.mjs";
  const mcpConfig = {
    mcpServers: {
      paperclip: {
        type: "stdio",
        command: "node",
        args: [mcpServerPath],
      },
    },
  };

  const args = [
    "--print",
    "-",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--strict-mcp-config",
  ];
  if (model) args.push("--model", model);
  args.push(...extraArgs);

  const child = spawn("claude", args, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  const STREAM_LIMIT = 8 * 1024 * 1024; // 8MB cap per stream
  let stdoutBytes = 0;
  let stderrBytes = 0;

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk); // echo to Fly logs for live debugging
    if (stdoutBytes < STREAM_LIMIT) {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    }
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    if (stderrBytes < STREAM_LIMIT) {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    }
  });

  child.stdin.write(prompt);
  child.stdin.end();

  const { exitCode, signal } = await new Promise((resolve) => {
    child.on("error", (err) => {
      console.error(`[shim] failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`);
      resolve({ exitCode: 127, signal: null });
    });
    child.on("exit", (code, sig) => {
      resolve({
        exitCode: typeof code === "number" ? code : sig ? 143 : 1,
        signal: sig ?? null,
      });
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  console.log(`[shim] claude exited code=${exitCode} signal=${signal ?? "null"} stdoutBytes=${stdoutBytes}`);

  const ok = await postCallback(callbackUrl, apiKey, {
    exitCode,
    signal,
    timedOut: false,
    stdout,
    stderr,
  });
  if (!ok) {
    console.error("[shim] failed to POST completion to control plane after 3 attempts");
    process.exit(exitCode === 0 ? 1 : exitCode);
  }

  console.log("[shim] completion posted, exiting");
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error(`[shim] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  const callbackUrl = process.env.PAPERCLIP_CALLBACK_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (callbackUrl && apiKey) {
    await postCallback(callbackUrl, apiKey, {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: String(err),
      errorMessage: String(err),
    }).catch(() => {});
  }
  process.exit(1);
});
