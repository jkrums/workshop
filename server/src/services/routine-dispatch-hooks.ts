import type { Db } from "@paperclipai/db";
import {
  formatBriefingDateLabel,
  gatherBriefingCounts,
  readHermesPersona,
} from "./daily-briefing.js";

// Pre-dispatch hooks run in `dispatchRoutineRun` just before variable
// resolution. They return a map of variable name → value that gets merged
// into `automaticVariables`, overriding any routine-declared defaults.
// Today this is a single switch on routine id (env-configured). When we
// add a second hook kind, promote the dispatch key to a
// `routines.dispatch_hook` column + registry lookup.

export interface DispatchHookContext {
  db: Db;
  routine: { id: string; companyId: string };
  source: "schedule" | "manual" | "api" | "webhook";
}

export async function buildPreDispatchVariables(
  ctx: DispatchHookContext,
): Promise<Record<string, string>> {
  const briefingRoutineId = process.env.WORKSHOP_DAILY_BRIEFING_ROUTINE_ID;
  if (briefingRoutineId && ctx.routine.id === briefingRoutineId) {
    return buildDailyBriefingVariables(ctx.db);
  }
  return {};
}

async function buildDailyBriefingVariables(
  db: Db,
): Promise<Record<string, string>> {
  const [counts, persona] = await Promise.all([
    gatherBriefingCounts(db),
    readHermesPersona(),
  ]);
  const workshopUrl =
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? "";
  return {
    persona: persona.trim(),
    date_label: formatBriefingDateLabel(),
    workshop_url: workshopUrl,
    open_issues_count: String(counts.openIssues),
    pending_approvals_count: String(counts.pendingApprovals),
    active_routines_count: String(counts.activeRoutines),
    companies_count: String(counts.companies),
  };
}
