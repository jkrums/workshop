---
type: ops
title: Atlas GitHub PAT setup
tags: [ops, atlas, secrets]
---

# Atlas GitHub PAT setup

This is the one-time config so Atlas can clone, commit, push, and the
approval handler can merge.

## What you need

- A **fine-grained** GitHub PAT.
- Scoped to the repos Atlas is allowed to touch (start with just
  `Lobbi-Group/lobbi` for now).
- Permissions:
  - **Contents**: Read and write
  - **Pull requests**: Read and write
  - **Metadata**: Read (required by default)
  - **Workflows**: Read and write *only if* Atlas will touch
    `.github/workflows/*`. Skip otherwise.
- Expiry: 90 days is fine; we'll build rotation tooling later.

## Mint it

1. https://github.com/settings/tokens?type=beta (personal fine-grained token)
2. Name: `workshop-atlas-lobbi`
3. Resource owner: your personal account
4. Repository access: only `Lobbi-Group/lobbi` (add more later)
5. Permissions above
6. Copy the `github_pat_…` string somewhere safe (1Password "Workshop
   — Atlas GitHub PAT").

## Store it in Workshop

By convention, every Workshop company stores its GitHub PAT as a
company secret named **`github_token`**. Do not rename — the approval
handler in `server/src/services/pr-merge.ts` looks for that exact
name, and Atlas's skill tells it to expect a `GITHUB_TOKEN` env var.

Today there is no dedicated UI for company secrets, so create it via
MCP or direct API. Easiest path: run in a Claude Code session with
the Paperclip MCP server attached:

```
paperclipCreateSecret({
  companyId: "<lobbi company uuid>",
  name: "github_token",
  provider: "local_encrypted",
  value: "<paste the fine-grained PAT here>",
  description: "Workshop → Lobbi repo access for Atlas + PR merge approvals"
})
```

> If that MCP tool isn't surfaced yet, post the secret directly via the
> REST endpoint — see `server/src/routes/secrets.ts` for the shape.

## Wire it into Atlas's adapter config

Atlas's agent record needs an `adapterConfig.env` entry pointing at
that secret. Example payload (Workshop UI → Agents → Atlas → edit adapter config):

```json
{
  "env": {
    "GITHUB_TOKEN": {
      "type": "secret_ref",
      "secretId": "<uuid returned by paperclipCreateSecret>",
      "version": "latest"
    }
  }
}
```

At heartbeat time, `resolveAdapterConfigForRuntime()` swaps the
`secret_ref` for the plaintext PAT and injects it as `GITHUB_TOKEN`
in the subprocess env. Atlas's skill tells it to use
`https://x-access-token:${GITHUB_TOKEN}@github.com/...` for clone
and push — so the secret never lands on disk.

## Rotation

When the PAT expires:
1. Mint a new one (same scopes).
2. Run `paperclipCreateSecret` with the same `name: "github_token"` —
   the secrets service versions it automatically.
3. The adapter config still points at `version: "latest"`, so next
   heartbeat picks up the new value. Nothing else to change.

## Revocation

If you need to pull Atlas's access immediately:
- Revoke the PAT in the GitHub UI (takes effect within seconds).
- Optionally also delete / disable the company secret in Workshop for
  audit clarity.
- The next heartbeat will fail to clone; Atlas should post a clean
  error on the issue and release it.
