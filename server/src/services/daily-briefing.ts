import { and, eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, companies, issues, routines } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { notifyTelegram } from "./telegram-notifications.js";

// Briefing fires at 08:00 Europe/Zurich (Janis's local morning).
// Not wired to the routines table because routines require an
// assigneeAgentId and dispatch to an agent — which Fly can't execute yet.
// When remote workers exist, migrate this to a proper routine row.

const BRIEFING_HOUR_LOCAL = 8;
const BRIEFING_TIMEZONE = "Europe/Zurich";
const POLL_INTERVAL_MS = 60 * 1000;

const CLOSED_ISSUE_STATUSES = ["done", "cancelled"] as const;

export async function runDailyBriefing(db: Db): Promise<void> {
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

  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: BRIEFING_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

  const base =
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? "";

  const lines = [
    `🌅 *Workshop — ${dateLabel}*`,
    ``,
    `• Open issues: *${openIssues}*`,
    `• Pending approvals: *${pendingApprovals}*`,
    `• Active routines: *${activeRoutines}*`,
    `• Companies: *${companyCount}*`,
  ];
  if (base) {
    lines.push(``, `[Open Workshop](${base})`);
  }

  await notifyTelegram(lines.join("\n"));
  logger.info(
    { openIssues, pendingApprovals, activeRoutines, companyCount },
    "daily briefing sent",
  );
}

// Ticker state. Stored by the Europe/Zurich calendar date we last fired for
// — so a restart during 08:00–08:59 will re-fire at most once. Acceptable
// for now; move to durable state (file or DB) if double-sends become a
// problem.
interface TickerState {
  lastFiredDate: string | null;
}

export function createBriefingTicker(db: Db) {
  const state: TickerState = { lastFiredDate: null };

  return {
    tick: async () => {
      const { date, hour } = localParts(new Date());
      if (hour !== BRIEFING_HOUR_LOCAL) return;
      if (state.lastFiredDate === date) return;
      state.lastFiredDate = date;
      try {
        await runDailyBriefing(db);
      } catch (err) {
        logger.error({ err }, "daily briefing failed");
      }
    },
  };
}

export function startDailyBriefingScheduler(db: Db): () => void {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    logger.info(
      "daily briefing scheduler not started — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID unset",
    );
    return () => {};
  }

  const ticker = createBriefingTicker(db);
  const handle = setInterval(() => {
    void ticker.tick();
  }, POLL_INTERVAL_MS);
  logger.info(
    { timezone: BRIEFING_TIMEZONE, hour: BRIEFING_HOUR_LOCAL },
    "daily briefing scheduler started",
  );
  return () => clearInterval(handle);
}

function localParts(now: Date): { date: string; hour: number } {
  // en-CA short date formats as YYYY-MM-DD; hour24 avoids AM/PM parsing.
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: BRIEFING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const hourStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: BRIEFING_TIMEZONE,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  return { date, hour: Number.parseInt(hourStr, 10) };
}
