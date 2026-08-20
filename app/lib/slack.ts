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
  /** Whether this is a reply inside a thread rather than a message in the channel itself. */
  isReply?: boolean;
};

/** One message as Slack sends it, before it is reduced to the fields a brief needs. */
type RawMessage = Record<string, unknown>;

/** Text a brief must never read as activity: a quiet channel somebody joined is still a quiet channel. */
const isRealMessage = (message: RawMessage) =>
  typeof message.text === "string"
  && String(message.text).trim().length > 0
  && !String(message.subtype ?? "").startsWith("channel_");

const asMessage = (message: RawMessage, isReply = false): SlackMessage => ({
  ts: String(message.ts ?? ""),
  at: new Date(Number(message.ts ?? 0) * 1000),
  author: String(message.user ?? message.bot_id ?? "unknown"),
  text: String(message.text ?? ""),
  replies: Number(message.reply_count ?? 0),
  isReply,
});

/**
 * How many `conversations.replies` calls may be in flight at once.
 *
 * The method is rate limited per minute, and a fortnight of a busy channel can hold fifty threads. Eight
 * at a time reads them all in about a second without arriving as one burst, which matters because the
 * whole brief has a sixty-second ceiling and a 429 here would cost more time than the throttle does.
 */
const THREAD_CONCURRENCY = 8;

/** Runs `work` over `items` a few at a time, in order, keeping results aligned with the input. */
async function pooled<In, Out>(items: In[], size: number, work: (item: In) => Promise<Out>): Promise<Out[]> {
  const results: Out[] = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, runner));
  return results;
}

/**
 * The last `days` of a channel, oldest first, threads and all.
 *
 * Oldest first because the model is being asked what happened over a fortnight and in what order, and
 * Slack returns newest first. Reversing here means no prompt has to explain the ordering.
 *
 * Threads are walked, not just counted. This channel is where the agency agrees what it will do, and in
 * Slack that agreement almost always happens *in the thread* — the parent message is "here's the list,
 * what do you think" and the commitment is the fourth reply down. A brief built from parents alone reads
 * a channel full of decisions as a channel full of links.
 *
 * `raw` is how many messages Slack handed over before any were dropped. A channel that reads as quiet
 * because it is full of joins and empty messages is indistinguishable from a channel nobody posted in,
 * and the two need opposite responses, so the count before filtering is reported rather than discarded.
 */
export async function channelHistory(
  channelId: string,
  days: number,
  limit = 200,
): Promise<{ messages: SlackMessage[]; raw: number; threads: number; replies: number }> {
  const oldest = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
  const params = new URLSearchParams({ channel: channelId, oldest: oldest.toFixed(6), limit: String(Math.min(1000, Math.max(1, limit))) });
  const body = await call(`conversations.history?${params.toString()}`, { method: "GET" });
  const raw = Array.isArray(body.messages) ? (body.messages as RawMessage[]) : [];
  const parents = raw.filter(isRealMessage).reverse();

  // Only threads whose parent survived filtering, because a thread hanging off a join notice is not a
  // conversation. `reply_count` is Slack's own count, so nothing is fetched speculatively.
  const heads = parents.filter((message) => Number(message.reply_count ?? 0) > 0);
  const fetched = await pooled(heads, THREAD_CONCURRENCY, async (head) => {
    const query = new URLSearchParams({ channel: channelId, ts: String(head.ts ?? ""), limit: "200" });
    try {
      const thread = await call(`conversations.replies?${query.toString()}`, { method: "GET" });
      const all = Array.isArray(thread.messages) ? (thread.messages as RawMessage[]) : [];
      // Slack returns the parent as the first element of its own thread; keeping it would print every
      // threaded message twice.
      return all.filter((message) => String(message.ts ?? "") !== String(head.ts ?? "")).filter(isRealMessage);
    } catch {
      // One unreadable thread must not cost the channel. The parent still carries its reply count, so
      // the transcript says a conversation happened even where its contents could not be read.
      return [] as RawMessage[];
    }
  });

  const repliesFor = new Map<string, RawMessage[]>();
  heads.forEach((head, index) => repliesFor.set(String(head.ts ?? ""), fetched[index] ?? []));

  const messages: SlackMessage[] = [];
  for (const parent of parents) {
    messages.push(asMessage(parent));
    for (const reply of repliesFor.get(String(parent.ts ?? "")) ?? []) messages.push(asMessage(reply, true));
  }

  return {
    raw: raw.length,
    threads: heads.length,
    replies: messages.filter((message) => message.isReply).length,
    messages,
  };
}

/**
 * The human replies in one thread, oldest first, with QC Bot's own messages taken out.
 *
 * This is how a brief reads the team's answer to its last brief. The brief is posted as a header in the
 * channel with the brief itself hanging off it in a thread, and a teammate replies in that thread to say
 * an item is handled. `conversations.replies` takes the timestamp of *any* message in a thread and returns
 * the whole thread, so the `slack_message_ts` already stored against a brief is enough to find its replies
 * — the header's own timestamp does not have to be kept as well.
 *
 * QC Bot's two messages, the header and the brief, both carry a `bot_id`, so dropping every message with
 * one leaves exactly the human replies. A thread with no human reply comes back empty, which is the normal
 * case and not an error: most briefs are read and acted on without anybody writing back.
 *
 * Never throws for a thread that cannot be read. A renamed channel or a deleted message is one brief's
 * replies going missing, not a reason to fail the brief being written now.
 */
export async function threadReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
  if (!channelId || !threadTs) return [];
  const query = new URLSearchParams({ channel: channelId, ts: threadTs, limit: "200" });
  try {
    const body = await call(`conversations.replies?${query.toString()}`, { method: "GET" });
    const all = Array.isArray(body.messages) ? (body.messages as RawMessage[]) : [];
    // `bot_id` is set on both of QC Bot's own messages and absent on a person's, so this one filter drops
    // the header and the brief and keeps the replies, without having to know the bot's user id.
    return all.filter((message) => !message.bot_id && isRealMessage(message)).map((message) => asMessage(message, true));
  } catch {
    return [];
  }
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

/**
 * A transcript a model can read, with ids replaced by names and days marked.
 *
 * Replies are indented under the message they answer rather than flattened into the day. Who replied to
 * what is the whole difference between "Kori asked whether the list was ready" and "Kori asked, and Dan
 * said he would have it by Friday" — flattened, the second reads as two unrelated remarks.
 */
export function transcript(messages: SlackMessage[], names: Map<string, string>, timezone: string): string {
  const dayOf = (at: Date) => at.toLocaleDateString("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
  const timeOf = (at: Date) => at.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  let lastDay = "";
  const lines: string[] = [];
  for (const message of messages) {
    const day = dayOf(message.at);
    // Only the channel's own messages open a day. A reply carries the date of the thread it is in, and a
    // "## Thu" appearing halfway down a thread would date the parent wrongly.
    if (!message.isReply && day !== lastDay) { lines.push(`\n## ${day}`); lastDay = day; }
    const who = names.get(message.author) ?? message.author;
    const said = message.text.replace(/\s+/g, " ").trim();
    if (message.isReply) { lines.push(`    ↳ ${timeOf(message.at)} ${who}: ${said}`); continue; }
    const thread = message.replies ? ` [thread, ${message.replies} ${message.replies === 1 ? "reply" : "replies"}]` : "";
    lines.push(`${timeOf(message.at)} ${who}: ${said}${thread}`);
  }
  return lines.join("\n").trim();
}

/**
 * Posts a message and returns Slack's timestamp for it, which is the id you would need to edit it.
 *
 * Always the bot token, never the user token, even when only a user token is set. A brief that arrives
 * in a client-facing channel under a person's own name reads as that person having written it, and the
 * first thing anyone does is reply to them about it. It has to be visibly from QC Bot or not sent.
 *
 * `threadTs` is the `ts` of the message to reply under. A morning brief is a page long and the internal
 * channel is where the team actually talks, so the brief goes in a thread hanging off a one-line header
 * rather than into the channel itself — three of those a week, unthreaded, and the channel is the brief.
 * Deliberately not `reply_broadcast`: a broadcast reply puts the whole thing back in the channel and
 * undoes the point of threading it.
 */
export async function postMessage(channelId: string, text: string, threadTs = ""): Promise<string> {
  const body = await call("chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    // `unfurl_links: false` because a brief that quotes a campaign URL should not paste a preview card
    // under itself, and `mrkdwn` because the brief is written in Slack's own flavour of markdown.
    body: JSON.stringify({
      channel: channelId,
      text,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  }, "write");
  return String(body.ts ?? "");
}

/**
 * Edits a message already posted, by the `ts` `postMessage` returned.
 *
 * This is how the Slack assistant shows its working: one message is posted the moment a question lands
 * and then rewritten in place as the agent moves through its sources, and rewritten a last time with the
 * finished answer — so the thread carries a single reply that fills in, not a placeholder followed by a
 * duplicate. Same bot token, same mrkdwn and no-unfurl treatment as `postMessage`, because it is the
 * same message.
 */
export async function updateMessage(channelId: string, ts: string, text: string): Promise<void> {
  await call("chat.update", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      channel: channelId,
      ts,
      text,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    }),
  }, "write");
}

/**
 * Who QC Bot is, so its own messages can be told apart from everyone else's.
 *
 * The Slack assistant reads back a whole thread to carry a conversation, and it has to know which posts
 * are its own — those are the assistant's prior turns, everyone else's are the human's. A message from
 * QC Bot carries either `user` equal to this user id or `bot_id` equal to this bot id, and which of the
 * two Slack fills in is not something to rely on, so both are captured. Asked of Slack once and cached:
 * the identity does not change for the life of the token, and `auth.test` is the one call every token
 * type accepts.
 */
let cachedIdentity: { userId: string; botId: string } | null = null;
export async function botIdentity(): Promise<{ userId: string; botId: string }> {
  if (cachedIdentity) return cachedIdentity;
  const token = botToken();
  if (!token) return (cachedIdentity = { userId: "", botId: "" });
  const body = await raw(token, "auth.test", { method: "POST" }).catch(() => ({ ok: false, status: 0 } as SlackReply & { status: number }));
  cachedIdentity = body.ok ? { userId: String(body.user_id ?? ""), botId: String(body.bot_id ?? "") } : { userId: "", botId: "" };
  return cachedIdentity;
}

/** One post in a thread, reduced to what an ongoing conversation needs: who said it and what they said. */
export type ThreadPost = { author: string; botId: string; text: string; ts: string };

/**
 * The whole thread, QC Bot's own messages included.
 *
 * Unlike `threadReplies`, which drops every `bot_id` message because a brief reads human activity, this
 * keeps them: the assistant's past answers are the memory that makes a follow-up a conversation rather
 * than a cold start. Only channel-noise subtypes (joins, leaves) and empty messages are dropped;
 * `author` and `botId` are handed back raw so the caller can decide which posts were the bot's own.
 */
export async function threadPosts(channelId: string, threadTs: string): Promise<ThreadPost[]> {
  if (!channelId || !threadTs) return [];
  const query = new URLSearchParams({ channel: channelId, ts: threadTs, limit: "200" });
  try {
    const body = await call(`conversations.replies?${query.toString()}`, { method: "GET" });
    const all = Array.isArray(body.messages) ? (body.messages as RawMessage[]) : [];
    return all
      .filter((message) => typeof message.text === "string" && String(message.text).trim().length > 0 && !String(message.subtype ?? "").startsWith("channel_"))
      .map((message) => ({
        author: String(message.user ?? ""),
        botId: String(message.bot_id ?? ""),
        text: String(message.text ?? ""),
        ts: String(message.ts ?? ""),
      }));
  } catch {
    return [];
  }
}

/**
 * Adds and removes an emoji reaction, which is how the assistant signals "I'm on it".
 *
 * The bot puts :eyes: on the message that asked the moment it starts, and takes it off when the answer is
 * posted — a quiet, in-place "working / done" that does not add a message to the thread. Slack answers
 * `already_reacted` if the emoji is already there and `no_reaction` if it was never added; both mean the
 * state is already what we wanted, so the caller treats a throw here as nothing to worry about.
 */
export async function addReaction(channelId: string, ts: string, name: string): Promise<void> {
  await call("reactions.add", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: channelId, timestamp: ts, name }),
  }, "write");
}

export async function removeReaction(channelId: string, ts: string, name: string): Promise<void> {
  await call("reactions.remove", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: channelId, timestamp: ts, name }),
  }, "write");
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
