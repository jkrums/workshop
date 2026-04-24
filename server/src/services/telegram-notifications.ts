// Fires outbound Telegram messages for Workshop event notifications.
// No-ops silently when TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID are unset,
// so local dev doesn't require them.

const TELEGRAM_API_BASE = "https://api.telegram.org";

export async function notifyTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[telegram] send failed: ${response.status} ${body}`);
    }
  } catch (err) {
    console.error(
      `[telegram] send error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function approvalsLink(): string {
  const base =
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.replace(/\/+$/, "") ??
    process.env.PAPERCLIP_PUBLIC_URL?.replace(/\/+$/, "") ??
    "";
  return base ? `${base}/approvals` : "/approvals";
}

export function buildApprovalNotification(opts: {
  approvalId: string;
  approvalType: string;
  companyId: string;
}): string {
  return [
    `🔔 *New approval requested*`,
    `Type: \`${opts.approvalType}\``,
    `[Open Workshop](${approvalsLink()})`,
  ].join("\n");
}

export function buildLoopDetectedNotification(opts: {
  agentName: string;
  issueLabel: string;
  runCount: number;
  disabledTriggerCount: number;
}): string {
  return [
    `🔁 *Same-issue loop detected*`,
    `Agent: *${opts.agentName}*`,
    `Issue: \`${opts.issueLabel}\` (${opts.runCount} successful runs in window)`,
    `${opts.disabledTriggerCount} routine trigger${opts.disabledTriggerCount === 1 ? "" : "s"} auto-disabled.`,
    `[Review & re-enable](${approvalsLink()})`,
  ].join("\n");
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function buildBudgetBreachNotification(opts: {
  scopeType: "company" | "agent" | "project";
  scopeName: string;
  windowKind: string;
  amountObserved: number;
  amountLimit: number;
}): string {
  const windowLabel =
    opts.windowKind === "rolling_hour"
      ? "past hour"
      : opts.windowKind === "rolling_day"
        ? "past 24 hours"
        : opts.windowKind === "calendar_month_utc"
          ? "this month"
          : opts.windowKind;
  const base =
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.replace(/\/+$/, "") ??
    process.env.PAPERCLIP_PUBLIC_URL?.replace(/\/+$/, "") ??
    "";
  const link = base ? `${base}/approvals` : "/approvals";
  return [
    `🛑 *Budget hard-stop tripped*`,
    `${opts.scopeType}: *${opts.scopeName}*`,
    `Spent ${formatUsd(opts.amountObserved)} / ${formatUsd(opts.amountLimit)} (${windowLabel})`,
    `${opts.scopeType === "agent" ? "Agent" : opts.scopeType === "company" ? "Company" : "Project"} paused. Approve or raise the budget:`,
    `[Open approvals](${link})`,
  ].join("\n");
}
