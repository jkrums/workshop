# Incident — `paperclipApiRequest` 404s on documented routes (doubled `/api` prefix)

**Date:** 2026-05-14
**Surfaced by:** Lobbi CEO on LOB-24 working from the bundled `paperclip-create-agent` skill
**Severity:** false 404 — the route exists, the curl-equivalent call works
**Fix:** [PR normalizing the path prefix in MCP client](packages/mcp-server/src/client.ts)

## What happened

CEO followed `skills/paperclip-create-agent/SKILL.md` and tried four
documented routes via `paperclipApiRequest`:

- `GET  /api/agents/me`
- `GET  /api/companies/:companyId/agent-configurations`
- `POST /api/companies/:companyId/agent-hires`
- (and likely the rest of the `/companies/:companyId/*` family)

Every one returned 404. Same routes called via direct `curl` with
`$PAPERCLIP_API_URL` and `$PAPERCLIP_API_KEY` worked first try.

## Root cause

The MCP server's `PaperclipApiClient.requestJson` (in
`packages/mcp-server/src/client.ts`) built the URL like this:

```ts
const url = new URL(path.slice(1), `${this.config.apiUrl}/`);
```

`apiUrl` is normalized in `config.ts` to always end with `/api`. The caller's
`path` starts with `/`. If the caller passed `/agents/me`, you got
`https://host/api/agents/me` — fine. If they passed `/api/agents/me`,
`path.slice(1)` is `api/agents/me`, the base is `https://host/api/`, and
the `URL` constructor produces **`https://host/api/api/agents/me`** — 404.

The skill that ships in the worker image (`paperclip-create-agent/SKILL.md`)
shows every example as a curl URL like
`$PAPERCLIP_API_URL/api/agents/me`. Agents reading that file naturally
translate the path into `/api/agents/me` when calling the MCP tool, and the
tool description even says it makes requests "to an existing Paperclip /api
endpoint." Doubling was the default behavior.

## Fix

Normalize the path in the client to accept either form:

```ts
const normalizedPath = path === "/api"
  ? "/"
  : path.startsWith("/api/")
    ? path.slice("/api".length)
    : path;
const url = new URL(normalizedPath.slice(1), `${this.config.apiUrl}/`);
```

Plus a tweak to the `paperclipApiRequest` tool description so the docstring
matches the actual contract (both forms accepted), and four new test cases
in `tools.test.ts` covering relative paths, `/api`-prefixed paths, and
company-scoped POSTs.

## Verification

After deploy + worker rebuild: in a worker session, call
`paperclipApiRequest` for each of the four routes the CEO tried on LOB-24.
All four should return 200/201 instead of 404, matching curl behavior.

## Related

- PR #25 baked `skills/` into the worker image so agents can read these
  contracts at runtime. Now the docs and the wrapper agree on the path
  format.
