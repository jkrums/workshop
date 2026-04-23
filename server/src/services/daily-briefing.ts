import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, companies, issues, routines } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// Dispatch-time helpers for the daily briefing routine. The routine row
// in Postgres owns the schedule + prompt template; this module just
// computes the fresh variables (counts, persona, date label) that
// `routine-dispatch-hooks.ts` merges into the template interpolation
// before each run.

export const BRIEFING_TIMEZONE = "Europe/Zurich";

const CLOSED_ISSUE_STATUSES = ["done", "cancelled"] as const;

export interface BriefingCounts {
  openIssues: number;
  pendingApprovals: number;
  activeRoutines: number;
  companies: number;
}

export async function gatherBriefingCounts(db: Db): Promise<BriefingCounts> {
  const [openIssues, pendingApprovals, activeRoutines, companyCount] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(not(inArray(issues.status, [...CLOSED_ISSUE_STATUSES])))
        .then((rows) => rows[0]?.count ?? 0),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(approvals)
        .where(eq(approvals.status, "pending"))
        .then((rows) => rows[0]?.count ?? 0),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(routines)
        .where(eq(routines.status, "active"))
        .then((rows) => rows[0]?.count ?? 0),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(companies)
        .then((rows) => rows[0]?.count ?? 0),
    ]);

  return {
    openIssues,
    pendingApprovals,
    activeRoutines,
    companies: companyCount,
  };
}

// Resolves the persona-hermes SKILL.md path. On Fly deploy the repo root
// is /app; in dev it's the workshop checkout.
export async function readHermesPersona(): Promise<string> {
  const candidates = [
    process.env.WORKSHOP_HERMES_SKILL_PATH,
    path.resolve(process.cwd(), "skills/persona-hermes/SKILL.md"),
    "/app/skills/persona-hermes/SKILL.md",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      /* try next */
    }
  }
  logger.warn({ candidates }, "persona-hermes SKILL.md not found; using fallback");
  return "You are Hermes, Chief of Staff for Workshop. Be terse and direct.";
}

export function formatBriefingDateLabel(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BRIEFING_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
}
