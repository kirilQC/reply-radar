// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Slack side of Reply Radar: reading a channel, and posting to one.
 *
 * ── Two tokens, one workspace ────────────────────────────────────────────────────────────────────
 * Every channel Reply Radar touches lives in the same Slack workspace, so the tokens are environment
 * variables rather than per-client secrets. There are two of them because reading and posting are
 * different problems: reads use a teammate's user token, which is already a member of every channel
 * they are in, and posts use the bot token so the brief arrives from QC Bot. See `readToken`.
 *
 * If that ever stops being true — a client's own Slack, joined as a guest — the change is a token
 * column on `rr_workspaces` and a `token` argument threaded through these functions, not a rewrite:
 * nothing below assumes where a token came from except the two accessors at the top.
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
export const SLACK_USER_TOKEN_ENV = "SLACK_USER_TOKEN";

/** Which credential a call needs. Reading and posting are not the same permission here. */
export type SlackActor = "read" | "write";

export function botToken(): string {
  return (process.env[SLACK_TOKEN_ENV] ?? "").trim();
}

export function userToken(): string {
  return (process.env[SLACK_USER_TOKEN_ENV] ?? "").trim();
}

/**
 * Reading uses a teammate's own token when there is one, and the bot's otherwise.
 *
 * A bot can only read a channel it has been invited to, and the external channels are Slack Connect
 * channels shared with the client — where adding an app is the client org's decision, not ours. A user
 * token is already a member of every channel that person is in, which is all of them, so the read side
 * needs no invitations and cannot be locked out by somebody else's app policy.
 *
 * Posting deliberately does not fall back the other way: see `postMessage`.
 */
export function readToken(): string {
  return userToken() || botToken();
}

/** Whether channel history can be read at all. */
export function slackReadable(): boolean {
  return Boolean(readToken());
}

/** Whether a brief can actually be posted. Reading and posting fail separately, so they are asked separately. */
export function slackConfigured(): boolean {
  return Boolean(botToken());
}

/** One request with one named token, returning Slack's answer rather than throwing. */
async function raw(token: string, method: string, init: RequestInit): Promise<SlackReply & { status: number }> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as SlackReply;
  return { ...body, status: response.status };
}

async function call(method: string, init: RequestInit, actor: SlackActor = "read"): Promise<SlackReply> {
  const token = actor === "write" ? botToken() : readToken();
  if (!token) {
    throw new Error(actor === "write"
      ? `${SLACK_TOKEN_ENV} is not set, so nothing can be posted to Slack.`
      : `Neither ${SLACK_USER_TOKEN_ENV} nor ${SLACK_TOKEN_ENV} is set, so no channel can be read.`);
  }
  const body = await raw(token, method, init);
  // Slack's own errors are more useful than the status, and they are the ones a teammate can act on:
  // `channel_not_found` means the id is wrong, `not_in_channel` means whoever's token this is is not a member.
  if (!body.ok) throw new Error(slackErrorText(body.error, body.status, actor));
  return body;
}

/**
 * Slack's error slugs, in the words of somebody who has to fix them.
 *
 * The fix for the same slug differs by credential — `not_in_channel` on a read means add yourself or set
 * a user token, on a write it means invite the bot — so the actor is part of the answer, not decoration.
 */
export function slackErrorText(error: unknown, status?: number, actor: SlackActor = "read"): string {
  const code = typeof error === "string" ? error : "";
  const env = actor === "write" ? SLACK_TOKEN_ENV : (userToken() ? SLACK_USER_TOKEN_ENV : SLACK_TOKEN_ENV);
  if (code === "channel_not_found") return "Slack does not recognise that channel id. Check it on the client's configuration page.";
  if (code === "not_in_channel") {
    return actor === "write"
      ? "The QC Bot is not in that channel. Invite it, then try again."
      : `The account behind ${env} is not in that channel. Join it, or set ${SLACK_USER_TOKEN_ENV} to somebody who is.`;
  }
  if (code === "invalid_auth" || code === "not_authed" || code === "token_revoked") return `The ${env} is not valid. Re-issue it and set it again.`;
  if (code === "missing_scope") {
    return actor === "write"
      ? `The ${SLACK_TOKEN_ENV} is missing a scope. It needs chat:write.`
      : `The ${env} is missing a scope. It needs channels:history, groups:history, channels:read and users:read.`;
  }
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
 *
 * `raw` is how many messages Slack handed over before any were dropped. A channel that reads as quiet
 * because it is full of joins and empty messages is indistinguishable from a channel nobody posted in,
 * and the two need opposite responses, so the count before filtering is reported rather than discarded.
 */
export async function channelHistory(channelId: string, days: number, limit = 200): Promise<{ messages: SlackMessage[]; raw: number }> {
  const oldest = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
  const params = new URLSearchParams({ channel: channelId, oldest: oldest.toFixed(6), limit: String(Math.min(1000, Math.max(1, limit))) });
  const body = await call(`conversations.history?${params.toString()}`, { method: "GET" });
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  return {
    raw: messages.length,
    messages: messages
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
      .reverse(),
  };
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

/**
 * Posts a message and returns Slack's timestamp for it, which is the id you would need to edit it.
 *
 * Always the bot token, never the user token, even when only a user token is set. A brief that arrives
 * in a client-facing channel under a person's own name reads as that person having written it, and the
 * first thing anyone does is reply to them about it. It has to be visibly from QC Bot or not sent.
 */
export async function postMessage(channelId: string, text: string): Promise<string> {
  const body = await call("chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    // `unfurl_links: false` because a brief that quotes a campaign URL should not paste a preview card
    // under itself, and `mrkdwn` because the brief is written in Slack's own flavour of markdown.
    body: JSON.stringify({ channel: channelId, text, mrkdwn: true, unfurl_links: false, unfurl_media: false }),
  }, "write");
  return String(body.ts ?? "");
}

/* ── Diagnostics ─────────────────────────────────────────────────────────────────────────────────
 *
 * Three tokens look alike and behave nothing alike. `xoxb-` is a bot, `xoxp-` is a person, `xapp-` is
 * an app-level token that almost no Web API method accepts — paste that one into either variable and
 * every call comes back `not_allowed_token_type`, which reads like a scope problem and is not one.
 *
 * So rather than translate that error more sweetly, this asks Slack who each token is and reports the
 * answer. `auth.test` is the one method every token type accepts, and its reply distinguishes them:
 * a bot token comes back carrying `bot_id`, a user token does not.
 */

export type TokenReport = {
  env: string;
  role: SlackActor;
  present: boolean;
  /** The prefix as pasted, which is usually the whole diagnosis. */
  prefix: string;
  /** What Slack says it is: "bot", "user", or "" when the token was refused. */
  kind: string;
  /** The bot or person the token acts as. */
  identity: string;
  workspace: string;
  ok: boolean;
  error: string;
};

async function reportOn(env: string, token: string, role: SlackActor): Promise<TokenReport> {
  const prefix = token ? `${token.slice(0, 5)}…` : "";
  if (!token) return { env, role, present: false, prefix, kind: "", identity: "", workspace: "", ok: false, error: "Not set." };
  const body: SlackReply & { status: number } = await raw(token, "auth.test", { method: "POST" })
    .catch(() => ({ ok: false, error: "unreachable", status: 0 }));
  if (!body.ok) {
    const hint = String(body.error) === "not_allowed_token_type" && !token.startsWith("xoxb-") && !token.startsWith("xoxp-")
      ? ` This is not a bot or user token — those start xoxb- or xoxp-.`
      : "";
    return { env, role, present: true, prefix, kind: "", identity: "", workspace: "", ok: false, error: `${slackErrorText(body.error, body.status, role)}${hint}` };
  }
  return {
    env,
    role,
    present: true,
    prefix,
    // `bot_id` is present on a bot token and absent on a user token, which is the only reliable tell.
    kind: body.bot_id ? "bot" : "user",
    identity: String(body.user ?? body.bot_id ?? ""),
    workspace: String(body.team ?? ""),
    ok: true,
    error: "",
  };
}

/** Who each token is, asked of Slack rather than assumed. */
export function tokenReports(): Promise<TokenReport[]> {
  return Promise.all([
    reportOn(SLACK_USER_TOKEN_ENV, userToken(), "read"),
    reportOn(SLACK_TOKEN_ENV, botToken(), "write"),
  ]);
}

export type ChannelProbe = {
  label: string;
  id: string;
  name: string;
  isPrivate: boolean;
  /** A Slack Connect channel shared with the client, where adding an app is their decision. */
  isExternal: boolean;
  canRead: boolean;
  readError: string;
  canPost: boolean;
  postError: string;
};

/**
 * Whether a channel id can actually be read and posted to, tried rather than inferred.
 *
 * History is fetched with `limit: 1` because the question is only whether the call is permitted, and a
 * probe that pulled a week of somebody's channel to answer it would be reading conversations for the
 * sake of a green tick.
 *
 * Posting is probed with `conversations.info`, not a message. `chat:write.public` lets the bot post to
 * a public channel it never joined, but nothing lets it post where it cannot see the channel — and a
 * private channel the bot is not in reports `channel_not_found`, not `not_in_channel`, which is the
 * single most misleading error in this whole feature.
 */
export async function probeChannel(label: string, id: string): Promise<ChannelProbe> {
  const probe: ChannelProbe = { label, id, name: "", isPrivate: false, isExternal: false, canRead: false, readError: "", canPost: false, postError: "" };
  if (!id) { probe.readError = "Not set."; probe.postError = "Not set."; return probe; }

  const reader = readToken();
  if (!reader) probe.readError = `Neither ${SLACK_USER_TOKEN_ENV} nor ${SLACK_TOKEN_ENV} is set.`;
  else {
    const info = await raw(reader, `conversations.info?channel=${encodeURIComponent(id)}`, { method: "GET" });
    if (info.ok) {
      const channel = (info.channel ?? {}) as Record<string, unknown>;
      probe.name = String(channel.name ?? "");
      probe.isPrivate = Boolean(channel.is_private);
      probe.isExternal = Boolean(channel.is_ext_shared || channel.is_shared);
    }
    const history = await raw(reader, `conversations.history?channel=${encodeURIComponent(id)}&limit=1`, { method: "GET" });
    probe.canRead = Boolean(history.ok);
    if (!history.ok) probe.readError = slackErrorText(history.error, history.status, "read");
  }

  const bot = botToken();
  if (!bot) probe.postError = `${SLACK_TOKEN_ENV} is not set.`;
  else {
    const seen = await raw(bot, `conversations.info?channel=${encodeURIComponent(id)}`, { method: "GET" });
    probe.canPost = Boolean(seen.ok);
    if (!seen.ok) {
      probe.postError = String(seen.error) === "channel_not_found" && probe.isPrivate
        ? "QC Bot cannot see this private channel. Invite it with /invite @QC Bot."
        : slackErrorText(seen.error, seen.status, "write");
    }
  }
  return probe;
}
