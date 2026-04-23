import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, companies, issues, routines } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// Briefing fires at 08:00 Europe/Zurich. Dispatches a run to Hermes on the
// claude_remote adapter; Hermes writes the briefing prose and POSTs it to
// Telegram from inside the worker. Stats are pre-computed in-process (cheap,
// deterministic) and injected into Hermes's prompt via contextSnapshot.

const BRIEFING_HOUR_LOCAL = 8;
const BRIEFING_TIMEZONE = "Europe/Zurich";
const POLL_INTERVAL_MS = 60 * 1000;

const HERMES_AGENT_ID =
  process.env.WORKSHOP_HERMES_AGENT_ID ?? "7cd18929-ce7d-42ee-a3da-099385f4de33";

const CLOSED_ISSUE_STATUSES = ["done", "cancelled"] as const;

interface BriefingCounts {
  openIssues: number;
  pendingApprovals: number;
  activeRoutines: number;
  companies: number;
}

interface HeartbeatInvoker {
  invoke: (
    agentId: string,
    source?: "timer" | "assignment" | "on_demand" | "automation",
    contextSnapshot?: Record<string, unknown>,
    triggerDetail?: "manual" | "ping" | "callback" | "system",
    actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
  ) => Promise<unknown>;
}

async function gatherCounts(db: Db): Promise<BriefingCounts> {
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

// Resolves the persona-hermes SKILL.md path. In Fly deploy the repo root is
// /app; in dev it's the workshop checkout. Falls back to the process.cwd so
// tests run in either location.
async function readHermesPersona(): Promise<string> {
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

function buildBriefingPrompt(opts: {
  persona: string;
  dateLabel: string;
  counts: BriefingCounts;
  workshopUrl: string | null;
}): string {
  const { persona, dateLabel, counts, workshopUrl } = opts;
  const linkHint = workshopUrl ? `\nWorkshop URL: ${workshopUrl}` : "";
  return [
    persona.trim(),
    "",
    "---",
    "",
    "# Task: Daily briefing",
    "",
    `It is the morning of **${dateLabel}** (Europe/Zurich). Fire your daily briefing.`,
    "",
    "## Stats already gathered for you",
    "",
    `- Open issues: ${counts.openIssues}`,
    `- Pending approvals: ${counts.pendingApprovals}`,
    `- Active routines: ${counts.activeRoutines}`,
    `- Companies: ${counts.companies}`,
    "",
    "## Enrich via Paperclip MCP",
    "",
    "You have the Paperclip MCP wired in. Before writing, call `paperclipInboxLite` once to see what's actually in the inbox — unassigned issues, pending approvals, recent comments. Use its output to make the briefing specific (titles, identifiers), not generic.",
    "",
    "Do not fan out into many MCP calls. One inbox read is enough for this briefing.",
    "",
    "## Write the briefing",
    "",
    "Markdown. 4–8 lines max. Tone per your persona: terse, functional, WHAT/WHY/WHAT-YOU-NEED-TO-DECIDE. If counts are all zero, do NOT pad the briefing with filler — say so plainly. Reference specific issue identifiers (e.g. `LOB-3`) when you mention them. Sign off with just `— Hermes`.",
    "",
    "## Post it",
    "",
    "POST the briefing to Telegram:",
    "- URL: `https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage`",
    "- Body: `{\"chat_id\":\"$TELEGRAM_CHAT_ID\",\"text\":\"<briefing>\",\"parse_mode\":\"Markdown\"}`",
    "",
    "Use `curl`. Read `$TELEGRAM_BOT_TOKEN` and `$TELEGRAM_CHAT_ID` from your environment. Do not echo the token.",
    "",
    "After the POST returns 200 OK, output a single confirmation line and exit. No further tool calls." + linkHint,
  ].join("\n");
}

export async function runDailyBriefing(
  db: Db,
  heartbeat: HeartbeatInvoker,
): Promise<void> {
  const counts = await gatherCounts(db);

  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: BRIEFING_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

  const workshopUrl =
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? null;

  const persona = await readHermesPersona();

  const prompt = buildBriefingPrompt({ persona, dateLabel, counts, workshopUrl });

  await heartbeat.invoke(
    HERMES_AGENT_ID,
    "automation",
    {
      prompt,
      wakeReason: "daily_briefing",
      wakeSource: "automation",
      briefing: { counts, dateLabel, timezone: BRIEFING_TIMEZONE },
    },
    "system",
    { actorType: "system", actorId: null },
  );

  logger.info(
    { counts, hermesAgentId: HERMES_AGENT_ID, promptChars: prompt.length },
    "daily briefing dispatched to Hermes",
  );
}

// Ticker state. Stored by the Europe/Zurich calendar date we last fired for
// — so a restart during 08:00–08:59 will re-fire at most once. Acceptable
// for now; move to durable state (file or DB) if double-sends become a
// problem.
interface TickerState {
  lastFiredDate: string | null;
}

export function createBriefingTicker(db: Db, heartbeat: HeartbeatInvoker) {
  const state: TickerState = { lastFiredDate: null };

  return {
    tick: async () => {
      const { date, hour } = localParts(new Date());
      if (hour !== BRIEFING_HOUR_LOCAL) return;
      if (state.lastFiredDate === date) return;
      state.lastFiredDate = date;
      try {
        await runDailyBriefing(db, heartbeat);
      } catch (err) {
        logger.error({ err }, "daily briefing failed");
      }
    },
  };
}

export function startDailyBriefingScheduler(
  db: Db,
  heartbeat: HeartbeatInvoker,
): () => void {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    logger.info(
      "daily briefing scheduler not started — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID unset",
    );
    return () => {};
  }

  const ticker = createBriefingTicker(db, heartbeat);
  const handle = setInterval(() => {
    void ticker.tick();
  }, POLL_INTERVAL_MS);
  logger.info(
    { timezone: BRIEFING_TIMEZONE, hour: BRIEFING_HOUR_LOCAL, hermesAgentId: HERMES_AGENT_ID },
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
