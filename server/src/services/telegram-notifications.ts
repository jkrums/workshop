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

export function buildApprovalNotification(opts: {
  approvalId: string;
  approvalType: string;
  companyId: string;
}): string {
  const base =
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.replace(/\/+$/, "") ??
    process.env.PAPERCLIP_PUBLIC_URL?.replace(/\/+$/, "") ??
    "";
  const link = base ? `${base}/approvals` : "/approvals";
  return [
    `🔔 *New approval requested*`,
    `Type: \`${opts.approvalType}\``,
    `[Open Workshop](${link})`,
  ].join("\n");
}
