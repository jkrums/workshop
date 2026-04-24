import type { Db } from "@paperclipai/db";
import { companySecrets } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { gitHubApiBase, ghFetch } from "./github-fetch.js";
import { secretService } from "./secrets.js";
import { logger } from "../middleware/logger.js";

// Convention: every Workshop company that hosts code-working agents stores a
// fine-grained GitHub PAT as a company secret named "github_token". Atlas uses
// the same secret to clone + push; approvals use it to merge.
const GITHUB_TOKEN_SECRET_NAME = "github_token";

export interface PrMergePayload {
  owner: string;
  repo: string;
  prNumber: number;
  mergeMethod?: "merge" | "squash" | "rebase";
  hostname?: string;
}

export interface PrMergeResult {
  merged: boolean;
  sha?: string;
  message?: string;
  statusCode: number;
  body: unknown;
}

function isValidPayload(payload: unknown): payload is PrMergePayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.owner === "string" &&
    typeof p.repo === "string" &&
    typeof p.prNumber === "number" &&
    p.owner.length > 0 &&
    p.repo.length > 0 &&
    p.prNumber > 0
  );
}

async function resolveGithubToken(db: Db, companyId: string): Promise<string | null> {
  const secretRow = await db
    .select({ id: companySecrets.id })
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.name, GITHUB_TOKEN_SECRET_NAME),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!secretRow) return null;
  try {
    return await secretService(db).resolveSecretValue(companyId, secretRow.id, "latest");
  } catch (err) {
    logger.error({ err, companyId }, "failed to resolve github_token secret");
    return null;
  }
}

function normalizeHostname(input?: string): string {
  const raw = (input ?? "github.com").trim();
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return new URL(raw).hostname;
    }
    return raw;
  } catch {
    return "github.com";
  }
}

export async function mergePullRequest(
  db: Db,
  companyId: string,
  payload: unknown,
): Promise<PrMergeResult> {
  if (!isValidPayload(payload)) {
    return {
      merged: false,
      statusCode: 0,
      body: null,
      message: "pr_merge_requested approval payload is missing owner/repo/prNumber",
    };
  }

  const token = await resolveGithubToken(db, companyId);
  if (!token) {
    return {
      merged: false,
      statusCode: 0,
      body: null,
      message: `No "${GITHUB_TOKEN_SECRET_NAME}" company secret is configured; cannot merge PR ${payload.owner}/${payload.repo}#${payload.prNumber}.`,
    };
  }

  const hostname = normalizeHostname(payload.hostname);
  const apiBase = gitHubApiBase(hostname);
  const mergeMethod = payload.mergeMethod ?? "squash";
  const url = `${apiBase}/repos/${payload.owner}/${payload.repo}/pulls/${payload.prNumber}/merge`;

  const response = await ghFetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "workshop-paperclip-approvals",
    },
    body: JSON.stringify({ merge_method: mergeMethod }),
  });

  const body = await safeJsonBody(response);
  if (!response.ok) {
    logger.warn(
      { owner: payload.owner, repo: payload.repo, prNumber: payload.prNumber, statusCode: response.status, body },
      "pr_merge_requested: GitHub returned non-2xx",
    );
    return {
      merged: false,
      statusCode: response.status,
      body,
      message: typeof body?.message === "string" ? body.message : `GitHub merge failed: ${response.status}`,
    };
  }

  return {
    merged: Boolean(body?.merged ?? true),
    sha: typeof body?.sha === "string" ? body.sha : undefined,
    message: typeof body?.message === "string" ? body.message : undefined,
    statusCode: response.status,
    body,
  };
}

export async function commentOnPullRequest(
  db: Db,
  companyId: string,
  payload: unknown,
  comment: string,
): Promise<{ posted: boolean; statusCode: number }> {
  if (!isValidPayload(payload)) return { posted: false, statusCode: 0 };
  const token = await resolveGithubToken(db, companyId);
  if (!token) return { posted: false, statusCode: 0 };

  const hostname = normalizeHostname(payload.hostname);
  const apiBase = gitHubApiBase(hostname);
  const url = `${apiBase}/repos/${payload.owner}/${payload.repo}/issues/${payload.prNumber}/comments`;

  const response = await ghFetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "workshop-paperclip-approvals",
    },
    body: JSON.stringify({ body: comment }),
  });

  return { posted: response.ok, statusCode: response.status };
}

async function safeJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
