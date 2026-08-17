// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Slack side of Reply Radar: reading a channel, and posting to one.
 *
 * ── One bot, one workspace ───────────────────────────────────────────────────────────────────────
 * Every channel Reply Radar touches lives in the same Slack workspace, so there is one bot token and
 * it is an environment variable rather than a per-client secret. If that ever stops being true — a
 * client's own Slack, joined as a guest — the change is a token column on `rr_workspaces` and a
 * `token` argument threaded through these functions, not a rewrite: nothing below assumes the token
 * came from the environment except `botToken()` itself.
 *
 * ── Why there is no message table ────────────────────────────────────────────────────────────────
 * Channel history is read at the moment a brief is written and thrown away afterwards. Storing it
 * would mean keeping a copy of the team's conversations in Supabase indefinitely, which is a promise
 * to the people in those channels that nobody has asked them for, and it buys nothing: a brief reads
 * the last few days, and Slack already holds those. If a future automation needs history older than
 * Slack's own retention, that is the point to revisit it, deliberately.
 */

/** Slack replies 200 with `{ ok: false, error: "..." }`, so the HTTP status is not the answer. */
type SlackReply = Record<string, unknown> & { ok?: boolean; error?: string };

export const SLACK_TOKEN_ENV = "SLACK_BOT_TOKEN";

export function botToken(): string {
  return (process.env[SLACK_TOKEN_ENV] ?? "").trim();
}

export function slackConfigured(): boolean {
  return Boolean(botToken());
}

async function call(method: string, init: RequestInit): Promise<SlackReply> {
  const token = botToken();
  if (!token) throw new Error(`${SLACK_TOKEN_ENV} is not set, so Slack cannot be reached.`);
  const response = await fetch(`https://slack.com/api/${method}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as SlackReply;
  // Slack's own errors are more useful than the status, and they are the ones a teammate can act on:
  // `channel_not_found` means the id is wrong, `not_in_channel` means the bot was never invited.
  if (!body.ok) throw new Error(slackErrorText(body.error, response.status));
  return body;
}

/** Slack's error slugs, in the words of somebody who has to fix them. */
export function slackErrorText(error: unknown, status?: number): string {
  const code = typeof error === "string" ? error : "";
  if (code === "channel_not_found") return "Slack does not recognise that channel id. Check it on the client's configuration page.";
  if (code === "not_in_channel") return "The Reply Radar bot is not in that channel. Invite it, then try again.";
  if (code === "invalid_auth" || code === "not_authed" || code === "token_revoked") return `The ${SLACK_TOKEN_ENV} is not valid. Re-issue the bot token and set it again.`;
  if (code === "missing_scope") return "The bot token is missing a scope. It needs channels:history, channels:read, users:read and chat:write.";
  if (code === "ratelimited") return "Slack is rate limiting us. Wait a minute and try again.";
  if (code) return `Slack refused the request: ${code}.`;
  return `Slack returned an unreadable reply${status ? ` (HTTP ${status})` : ""}.`;
}

export type SlackMessage = {
  /** Slack's message id, which is also its timestamp. */
  ts: string;
  at: Date;
  /** The user id, or a bot id when a message came from an app. */
  author: string;
  text: string;
  /** How many replies hang off this message, when it is the head of a thread. */
  replies: number;
};

/**
 * The last `days` of a channel, oldest first.
 *
 * Oldest first because the model is being asked what happened over a week and in what order, and
 * Slack returns newest first. Reversing here means no prompt has to explain the ordering.
 *
 * Threads are counted but not walked. A brief cares that a question got eleven replies; reading all
 * eleven costs a `conversations.replies` call per thread and buys detail the brief would not use.
 */
export async function channelHistory(channelId: string, days: number, limit = 200): Promise<SlackMessage[]> {
  const oldest = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
  const params = new URLSearchParams({ channel: channelId, oldest: oldest.toFixed(6), limit: String(Math.min(1000, Math.max(1, limit))) });
  const body = await call(`conversations.history?${params.toString()}`, { method: "GET" });
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  return messages
    .filter((message) => typeof message.text === "string" && String(message.text).trim())
    // Channel joins and leaves are noise a brief must never read as activity: a quiet channel that
    // somebody joined is still a quiet channel.
    .filter((message) => !String(message.subtype ?? "").startsWith("channel_"))
    .map((message) => ({
      ts: String(message.ts ?? ""),
      at: new Date(Number(message.ts ?? 0) * 1000),
      author: String(message.user ?? message.bot_id ?? "unknown"),
      text: String(message.text ?? ""),
      replies: Number(message.reply_count ?? 0),
    }))
    .reverse();
}

/**
 * Display names for the user ids that appear in a transcript.
 *
 * Without this the model is handed `U04AB12CD said` and the brief comes out talking about user ids,
 * which is unreadable. Fetched one at a time because `users.info` takes one id — but only for the ids
 * that actually spoke, which in a week of one channel is a handful of people, not the whole company.
 * A lookup that fails falls back to the raw id rather than failing the brief.
 */
export async function resolveUserNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => /^U[A-Z0-9]+$/i.test(id)))];
  const names = new Map<string, string>();
  await Promise.all(unique.map(async (id) => {
    try {
      const body = await call(`users.info?user=${encodeURIComponent(id)}`, { method: "GET" });
      const user = (body.user ?? {}) as Record<string, unknown>;
      const profile = (user.profile ?? {}) as Record<string, unknown>;
      const name = String(profile.display_name || profile.real_name || user.real_name || user.name || "").trim();
      if (name) names.set(id, name);
    } catch {
      // Left out of the map; callers fall back to the id.
    }
  }));
  return names;
}

/** A transcript a model can read, with ids replaced by names and days marked. */
export function transcript(messages: SlackMessage[], names: Map<string, string>, timezone: string): string {
  const dayOf = (at: Date) => at.toLocaleDateString("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
  const timeOf = (at: Date) => at.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  let lastDay = "";
  const lines: string[] = [];
  for (const message of messages) {
    const day = dayOf(message.at);
    if (day !== lastDay) { lines.push(`\n## ${day}`); lastDay = day; }
    const who = names.get(message.author) ?? message.author;
    const thread = message.replies ? ` [${message.replies} ${message.replies === 1 ? "reply" : "replies"} in thread]` : "";
    lines.push(`${timeOf(message.at)} ${who}: ${message.text.replace(/\s+/g, " ").trim()}${thread}`);
  }
  return lines.join("\n").trim();
}

/** Posts a message and returns Slack's timestamp for it, which is the id you would need to edit it. */
export async function postMessage(channelId: string, text: string): Promise<string> {
  const body = await call("chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    // `unfurl_links: false` because a brief that quotes a campaign URL should not paste a preview card
    // under itself, and `mrkdwn` because the brief is written in Slack's own flavour of markdown.
    body: JSON.stringify({ channel: channelId, text, mrkdwn: true, unfurl_links: false, unfurl_media: false }),
  });
  return String(body.ts ?? "");
}
