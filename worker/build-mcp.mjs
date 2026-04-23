#!/usr/bin/env node
// Bundles the in-repo Paperclip MCP stdio server into a single standalone
// .mjs file that the worker image copies in. Using the monorepo source
// (not the npm-published @paperclipai/mcp-server) guarantees the worker's
// MCP matches whatever Workshop's server is serving.

import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

await build({
  entryPoints: [resolve(repoRoot, "packages/mcp-server/src/stdio.ts")],
  outfile: resolve(__dirname, "dist/paperclip-mcp-server.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Inline everything — the worker image has no other node_modules on PATH,
  // and we want a single self-contained file.
  external: [],
  treeShaking: true,
  // stdio.ts already starts with a shebang — esbuild preserves the one
  // in source, so we do NOT add it again via banner.
  // MCP SDK and zod are pure JS; no native deps.
  // Workspace dep @paperclipai/shared resolves via tsconfig paths during build.
});

console.log("[build-mcp] wrote worker/dist/paperclip-mcp-server.mjs");
