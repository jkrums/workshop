#!/usr/bin/env node
// Bundles the in-repo Paperclip MCP stdio server into a single standalone
// .mjs file that the worker image copies in. Using the monorepo source
// (not the npm-published @paperclipai/mcp-server) guarantees the worker's
// MCP matches whatever Workshop's server is serving.
//
// Also syncs ../skills/ into ./skills/ so the worker Dockerfile can COPY
// them into the image (its build context is worker/, so it can't reach
// the repo-root skills/ directly). ./skills/ is gitignored.

import { build } from "esbuild";
import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// 1. Bundle the MCP stdio server.
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

// 2. Sync ../skills/ into ./skills/ for the Docker build context.
const skillsSrc = resolve(repoRoot, "skills");
const skillsDst = resolve(__dirname, "skills");
await rm(skillsDst, { recursive: true, force: true });
await mkdir(skillsDst, { recursive: true });
await cp(skillsSrc, skillsDst, { recursive: true });
const baked = await readdir(skillsDst);
console.log(
  `[build-mcp] synced ${baked.length} skills to worker/skills/: ${baked.join(", ")}`,
);
