// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Reply alerts, the side that reads the database and talks to Slack. The layout and the rules are in
 * reply-alert.ts; this file is the order things happen in.
 *
 * ── Two ways in, one post ───────────────────────────────────────────────────────────────────────
 * The HeyReach webhook calls `alertNewReplies` in `after()` the moment a reply is stored, which is the
 * fast path. The worker sweeps every minute for replies in the last 48 hours that never got a card
 * (a webhook that timed out, a reply found by reconciliation) and calls the alert route for each. Both
 * can reach the same reply at the same moment, so a reply is claimed before anything is posted.
 *
 * ── Why the claim is a row in rr_app_config, not a field on the message ─────────────────────────
 * The obvious place is the message's own raw_data.reply_radar, and it does not hold: ingestion rewrites
 * every message's raw_data on each webhook from a copy it read before the write, so a second webhook
 * landing while the first reply's draft is being written puts the message back the way it was, claim
 * gone, and the second webhook's alert claims it again. A lead who sends two messages in a row does
 * exactly that. An rr_app_config insert is atomic on its primary key and nothing else writes that row.
 * The message still carries `reply_alert` (channel, ts, thread_ts, posted_at, done_at) as a mirror for
 * the sweep to filter on and for anyone reading the row; if ingestion wipes the mirror, the next sweep
 * finds the claim marked posted and writes it back.
 */

import { randomUUID } from "node:crypto";
import { classifyConversationOrigin } from "../../shared/conversation-origin.mjs";
import { NEAR_DUPLICATE_MS } from "../../shared/message-identity.mjs";
import { burstText, laterInBurst, QUIET_MS } from "../../shared/reply-burst.mjs";
import { runDraft } from "./ai-draft";
import { writeAuditEvent } from "./audit-log";
import { sendConversationReply } from "./conversation-send";
import { dedupeMessages } from "./message-dedupe";
import { addReaction, postEphemeral, postMessage, resolveUserNames, slackConfigured, updateMessage } from "./slack";
import {
  buildAlertCard,
  buildAlertThread,
  claimVerdict,
  draftFromState,
  leadFromRow,
  parseSendValue,
  replyNumber,
  sendableCheck,
  sendClaimVerdict,
  sentThreadBlocks,
  twinIds,
  ALERT_MAX_ATTEMPTS,
  type AlertClaim,
  type AlertMessage,
  type SendClaim,
} from "./reply-alert";

type Row = Record<string, unknown>;
type Config = { url: string; key: string };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const radarOf = (raw: unknown) => object(object(raw).reply_radar);
const enc = encodeURIComponent;

/** Replies older than this are never posted, however they were missed: a two day old card is noise. */
export const ALERT_WINDOW_MS = 48 * 60 * 60 * 1000;
/** The channel a Configuration test goes to instead of the client's. Same variable as the other Slack tests. */
export const TEST_CHANNEL_ENV = "SLACK_TEST_CHANNEL_ID";

export function supabaseConfig(): Config | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

async function rest(config: Config, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  }).catch(() => null);
  if (!response) return { ok: false, status: 0, data: null };
  const body = await response.text().catch(() => "");
  let data: unknown = body;
  try { data = body ? JSON.parse(body) : null; } catch { /* keep the text */ }
  return { ok: response.ok, status: response.status, data };
}

async function rows(config: Config, path: string): Promise<Row[]> {
  const result = await rest(config, path);
  if (!result.ok) throw new Error(`Supabase ${path.split("?")[0]} ${result.status}: ${String(typeof result.data === "string" ? result.data : JSON.stringify(result.data)).slice(0, 200)}`);
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

const WORKSPACE_COLUMNS = "id,name,slug,offboarded_at,slack_replies_channel_id,reply_alerts_enabled,reply_alerts_enabled_at,anthropic_model,custom_system_prompt,client_brief";

/** The client with its alert settings, or null when it is gone or the migration has not been run. */
async function loadWorkspace(config: Config, id: string): Promise<Row | null> {
  if (!id) return null;
  const result = await rest(config, `rr_workspaces?select=${WORKSPACE_COLUMNS}&id=eq.${enc(id)}&limit=1`);
  return result.ok && Array.isArray(result.data) && result.data[0] ? (result.data[0] as Row) : null;
}

/** On, with a channel, and not offboarded. An offboarded client never gets an alert. */
export const alertsOn = (workspace: Row | null) =>
  Boolean(workspace && workspace.reply_alerts_enabled === true && text(workspace.slack_replies_channel_id) && !workspace.offboarded_at);

/**
 * The earliest reply that may be posted: never before alerts were switched on, so turning them on does
 * not flood the channel with the last two days, and never more than 48 hours back.
 */
export function windowStart(workspace: Row, now: number): number {
  const enabledAt = Date.parse(text(workspace.reply_alerts_enabled_at));
  return Math.max(Number.isFinite(enabledAt) ? enabledAt : now, now - ALERT_WINDOW_MS);
}

/** Writes into the message's raw_data.reply_radar.reply_alert, re-reading first like mergeMessageRadar. */
async function mirrorAlert(config: Config, messageId: string, patch: Row): Promise<void> {
  const current = await rest(config, `rr_messages?select=raw_data&id=eq.${enc(messageId)}&limit=1`);
  const row = Array.isArray(current.data) ? (current.data[0] as Row | undefined) : undefined;
  if (!current.ok || !row) return;
  const raw = object(row.raw_data);
  const radar = object(raw.reply_radar);
  await rest(config, `rr_messages?id=eq.${enc(messageId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ raw_data: { ...raw, reply_radar: { ...radar, reply_alert: { ...object(radar.reply_alert), ...patch } } } }),
  });
}

async function readConfigValue(config: Config, key: string): Promise<Row | null> {
  const result = await rest(config, `rr_app_config?select=value&key=eq.${enc(key)}&limit=1`);
  const row = result.ok && Array.isArray(result.data) ? (result.data[0] as Row | undefined) : undefined;
  return row ? object(row.value) : null;
}

/** Replaces a claim's value only if it still holds `token`, so two takers cannot both win. */
async function swapConfigValue(config: Config, key: string, token: string, value: Row): Promise<boolean> {
  const result = await rest(config, `rr_app_config?key=eq.${enc(key)}&value->>token=eq.${enc(token)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
  });
  return result.ok && Array.isArray(result.data) && result.data.length === 1;
}

export type ClaimResult =
  | { verdict: "take"; token: string; attempts: number; claimedAt: string }
  | { verdict: "posted" | "busy" | "gave_up"; existing: AlertClaim | null }
  | { verdict: "error"; error: string };

/**
 * Claims one alert so exactly one run posts it. The insert is the lock; a claim already there is taken
 * over only when `claimVerdict` says its holder failed or died, and only by a conditional swap on its
 * token. Anything unexpected from the database fails closed: the sweep will try again in a minute, which
 * is better than a second card.
 */
export async function claimAlert(config: Config, key: string, now = Date.now()): Promise<ClaimResult> {
  const token = randomUUID();
  const claimedAt = new Date(now).toISOString();
  const fresh: AlertClaim = { status: "claimed", token, attempts: 0, claimed_at: claimedAt };
  const inserted = await rest(config, "rr_app_config", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ key, value: fresh }) });
  if (inserted.ok) return { verdict: "take", token, attempts: 0, claimedAt };
  if (inserted.status !== 409) return { verdict: "error", error: `Supabase rr_app_config ${inserted.status}` };
  const existing = (await readConfigValue(config, key)) as AlertClaim | null;
  const verdict = claimVerdict(existing, now);
  if (verdict !== "take") return { verdict, existing };
  if (!existing) return { verdict: "busy", existing };
  // A stale claim is a run that died, which counts as an attempt; a recorded failure already counted itself.
  const attempts = (Number(existing.attempts) || 0) + (existing.status === "claimed" ? 1 : 0);
  const taken = await swapConfigValue(config, key, existing.token, { status: "claimed", token, attempts, claimed_at: claimedAt });
  return taken ? { verdict: "take", token, attempts, claimedAt } : { verdict: "busy", existing };
}

export type AlertOutcome = {
  outcome: "posted" | "already_posted" | "busy" | "skipped" | "failed" | "gave_up";
  reason?: string;
  channel?: string;
  ts?: string;
  threadTs?: string;
};

/** The draft the inbox would show: the cached one if it is newer than the reply, otherwise a fresh one. */
async function draftFor(workspace: Row, conversationId: string, thread: Row[], leadName: string, campaignName: string): Promise<string> {
  const latest = [...thread].reverse().find((row) => row.direction === "inbound");
  if (latest) {
    const radar = radarOf(latest.raw_data);
    const analyzedAt = Date.parse(text(radar.analyzed_at));
    if (text(radar.cached_draft) && Number.isFinite(analyzedAt) && analyzedAt > Date.parse(text(latest.sent_at))) return text(radar.cached_draft);
  }
  // Same request the worker's AI pipeline makes, so the draft and its cache are identical to the inbox's.
  const result = await runDraft({
    mode: "analyze",
    conversationId,
    workspaceId: text(workspace.id),
    workspaceName: text(workspace.name) || text(workspace.slug),
    leadName,
    campaignName: campaignName || undefined,
    model: text(workspace.anthropic_model) || undefined,
    system: text(workspace.custom_system_prompt) || undefined,
    instruction: text(workspace.client_brief) ? `Client context: ${text(workspace.client_brief)}` : "",
    thread: thread.map((row) => ({ direction: text(row.direction), body: String(row.body ?? ""), sentAt: text(row.sent_at) })),
  }).catch(() => null);
  return result?.status === 200 ? text(result.body.draft) : "";
}

/**
 * Posts the card and its thread for one inbound message, at most once.
 *
 * `test` posts the same thing to `channel` (the Slack test channel) with no claim, no stamp and a
 * Send button that refuses to send, for the button on Configuration.
 */
export async function alertMessage(config: Config, messageId: string, opts: { test?: boolean; channel?: string; retry?: boolean } = {}): Promise<AlertOutcome> {
  const test = opts.test === true;
  const [target] = await rows(config, `rr_messages?select=id,conversation_id,direction,body,sent_at,raw_data&id=eq.${enc(messageId)}&limit=1`);
  if (!target) return { outcome: "skipped", reason: "That message is not stored." };
  if (target.direction !== "inbound") return { outcome: "skipped", reason: "Only replies from the lead are posted." };
  // An out-of-office or other auto-reply, as Email Bison flags it, is not a reply anyone needs to act on.
  if (!opts.test && radarOf(target.raw_data).automated === true) {
    await mirrorAlert(config, messageId, { done_at: new Date().toISOString(), skipped: "automated" });
    return { outcome: "skipped", reason: "An automated reply (out of office)." };
  }
  const [conversation] = await rows(config, `rr_conversations?select=id,workspace_id,lead_id,heyreach_conversation_id,channel&id=eq.${enc(text(target.conversation_id))}&limit=1`);
  if (!conversation) return { outcome: "skipped", reason: "The conversation is gone." };
  const workspace = await loadWorkspace(config, text(conversation.workspace_id));
  if (!workspace) return { outcome: "skipped", reason: "The client could not be read. Has the reply alerts migration been run?" };
  const now = Date.now();
  if (!test) {
    if (!alertsOn(workspace)) return { outcome: "skipped", reason: "Reply alerts are off for this client." };
    if (Date.parse(text(target.sent_at)) < windowStart(workspace, now)) return { outcome: "skipped", reason: "The reply is older than the alert window." };
  }
  const channel = test ? text(opts.channel) : text(workspace.slack_replies_channel_id);
  if (!channel) return { outcome: "skipped", reason: "There is no channel to post to." };
  if (!slackConfigured()) return { outcome: "failed", reason: "SLACK_BOT_TOKEN is not set, so nothing can be posted." };

  const conversationId = text(conversation.id);
  const [stored, leads] = await Promise.all([
    rows(config, `rr_messages?select=id,conversation_id,direction,body,sent_at,raw_data&conversation_id=eq.${enc(conversationId)}&order=sent_at.asc,id.asc&limit=500`),
    text(conversation.lead_id) ? rows(config, `rr_leads?select=*&id=eq.${enc(text(conversation.lead_id))}&limit=1`) : Promise.resolve([] as Row[]),
  ]);
  const lead = leads[0] ?? {};
  const asMessage = (row: Row): AlertMessage => ({
    id: text(row.id),
    direction: text(row.direction),
    body: String(row.body ?? ""),
    sentAt: text(row.sent_at),
    senderName: text(object(radarOf(row.raw_data).sender).name),
  });

  // Same rule as ingestion and the inbox: someone who messaged us first is not a reply to our outreach.
  if (!test && classifyConversationOrigin({ messages: stored, leadRawData: lead.raw_data }).origin === "inbound_lead") {
    await mirrorAlert(config, messageId, { done_at: new Date(now).toISOString(), skipped: "inbound_lead" });
    return { outcome: "skipped", reason: "The lead messaged first, so this is not a reply to our outreach." };
  }

  const twins = twinIds(stored.map(asMessage), asMessage(target), NEAR_DUPLICATE_MS);

  // Two or three messages in a row from the lead ("Sounds great" then "Looking forward to the session")
  // get one card, on the newest; an earlier one is folded into it rather than posted on its own
  // (shared/reply-burst.mjs). A test post is never folded.
  if (!test) {
    const burstThread = dedupeMessages(stored).map(asMessage);
    const selfInThread = burstThread.find((message) => twins.includes(message.id)) ?? asMessage(target);
    const later = laterInBurst(burstThread, selfInThread);
    if (later) {
      await mirrorAlert(config, messageId, { done_at: new Date(now).toISOString(), skipped: "merged", merged_into: later.id });
      return { outcome: "skipped", reason: "Folded into the lead's next message, which carries one card for both." };
    }
  }
  const claimKey = `reply_alert:${twins[0]}`;
  let claim: Extract<ClaimResult, { verdict: "take" }> | null = null;
  if (!test) {
    const result = await claimAlert(config, claimKey, now);
    if (result.verdict === "posted") {
      // Already in Slack. The mirror on this copy may have been wiped by ingestion, so it is written back.
      const posted = result.existing;
      await mirrorAlert(config, messageId, { channel: posted?.channel, ts: posted?.ts, thread_ts: posted?.thread_ts, posted_at: posted?.posted_at, done_at: posted?.posted_at || new Date(now).toISOString() });
      return { outcome: "already_posted" };
    }
    // "Retry missed" on the Reply alerts page: a reply that ran out of attempts (QC Bot was not in the
    // channel) is taken over with its attempts reset, once someone has fixed what stopped it.
    if (result.verdict === "gave_up" && opts.retry && result.existing?.token) {
      const retriedAt = new Date(now).toISOString();
      const token = randomUUID();
      const taken = await swapConfigValue(config, claimKey, result.existing.token, { status: "claimed", token, attempts: 0, claimed_at: retriedAt });
      if (!taken) return { outcome: "busy" };
      claim = { verdict: "take", token, attempts: 0, claimedAt: retriedAt };
    } else if (result.verdict === "gave_up") {
      await mirrorAlert(config, messageId, { done_at: new Date(now).toISOString(), failed_at: result.existing?.failed_at, error: result.existing?.error, attempts: result.existing?.attempts });
      return { outcome: "gave_up", reason: result.existing?.error };
    }
    else if (result.verdict !== "take") return { outcome: "busy", reason: "error" in result ? result.error : undefined };
    else claim = result;
  }

  let cardTs = "";
  try {
    const thread = dedupeMessages(stored);
    const messages = thread.map(asMessage);
    const self = messages.find((message) => twins.includes(message.id)) ?? asMessage(target);
    const latest = [...messages].reverse().find((message) => message.direction === "inbound") ?? self;
    const senderName = [...messages].reverse().find((message) => message.direction === "outbound" && message.senderName)?.senderName
      || messages.find((message) => message.senderName)?.senderName || "";
    const campaignName = text(object(radarOf(stored.find((row) => row.id === messageId)?.raw_data).campaign).name)
      || thread.map((row) => text(object(radarOf(row.raw_data).campaign).name)).find(Boolean) || "";
    const leadFields = leadFromRow(lead);
    const draft = await draftFor(workspace, conversationId, thread, leadFields.name, campaignName);
    const card = buildAlertCard({ lead: leadFields, replyNumber: replyNumber(messages, self), senderName, campaignName, clientName: text(workspace.name), latestReply: burstText(messages, latest) || latest.body, test, channel: text(conversation.channel) === "email" || text(conversation.heyreach_conversation_id).startsWith("bison:") ? "email" : "linkedin" });
    const reply = buildAlertThread({ messages, latest, messageId, leadName: leadFields.name, senderName, draft, conversationId, test, channel: text(conversation.channel) === "email" || text(conversation.heyreach_conversation_id).startsWith("bison:") ? "email" : "linkedin" });

    cardTs = await postMessage(channel, card.text, "", card.blocks);
    // The card is out, so from here on nothing may release the claim: a retry would post a second card.
    let threadTs = "";
    try {
      threadTs = await postMessage(channel, reply.text, cardTs, reply.blocks);
    } catch (error) {
      const why = error instanceof Error ? error.message : "Slack refused it";
      await postMessage(channel, `Could not post the conversation and reply box: ${why}`, cardTs).catch(() => "");
    }
    const postedAt = new Date().toISOString();
    if (claim) {
      await swapConfigValue(config, claimKey, claim.token, { status: "posted", token: claim.token, attempts: claim.attempts, claimed_at: claim.claimedAt, channel, ts: cardTs, thread_ts: threadTs, posted_at: postedAt }).catch(() => false);
      await mirrorAlert(config, messageId, { channel, ts: cardTs, thread_ts: threadTs, posted_at: postedAt, done_at: postedAt }).catch(() => undefined);
      await writeAuditEvent(config, {
        actor: "slack_bot",
        action: "reply_alert.posted",
        entityType: "conversation",
        entityId: conversationId,
        details: { source: "slack", status: "success", workspaceId: text(workspace.id), workspaceName: text(workspace.name), channel, summary: `Posted ${leadFields.name || "a lead"}'s reply to the replies channel.` },
      }).catch(() => undefined);
    }
    return { outcome: "posted", channel, ts: cardTs, threadTs };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 500) : "The alert could not be posted.";
    if (claim && !cardTs) {
      // Released as a failure so the sweep tries again after ALERT_RETRY_AFTER_MS, up to ALERT_MAX_ATTEMPTS.
      const attempts = claim.attempts + 1;
      const failedAt = new Date().toISOString();
      await swapConfigValue(config, claimKey, claim.token, { status: "failed", token: claim.token, attempts, claimed_at: claim.claimedAt, failed_at: failedAt, error: reason }).catch(() => false);
      await mirrorAlert(config, messageId, attempts >= ALERT_MAX_ATTEMPTS ? { done_at: failedAt, failed_at: failedAt, error: reason, attempts } : { error: reason, attempts }).catch(() => undefined);
    }
    return { outcome: "failed", reason };
  }
}

/**
 * Every reply in this conversation that is inside the window and has no card yet, oldest first.
 *
 * Called from the webhook. Ingestion stores the whole thread on every event, so rather than work out
 * which message is new, it asks which replies have not been posted; the claim keeps that exactly once.
 */
export async function alertNewReplies(config: Config, conversationId: string): Promise<AlertOutcome[]> {
  const [conversation] = await rows(config, `rr_conversations?select=id,workspace_id&id=eq.${enc(conversationId)}&limit=1`);
  if (!conversation) return [];
  const workspace = await loadWorkspace(config, text(conversation.workspace_id));
  if (!workspace || !alertsOn(workspace)) return [];
  const since = new Date(windowStart(workspace, Date.now())).toISOString();
  const read = () => rows(
    config,
    `rr_messages?select=id,sent_at,alert:raw_data->reply_radar->reply_alert&conversation_id=eq.${enc(conversationId)}&direction=eq.inbound&sent_at=gte.${enc(since)}&order=sent_at.asc&limit=10`,
  );
  let candidates = await read();
  // A reply that just landed may be the first of a few: wait until the lead has been quiet for QUIET_MS,
  // then read again, so the whole burst is posted as one card on its newest message.
  const newest = Math.max(0, ...candidates.filter((row) => !text(object(row.alert).done_at)).map((row) => Date.parse(text(row.sent_at)) || 0));
  const wait = newest ? QUIET_MS - (Date.now() - newest) : 0;
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, QUIET_MS)));
    candidates = await read();
  }
  const outcomes: AlertOutcome[] = [];
  for (const row of candidates) {
    if (text(object(row.alert).done_at)) continue;
    outcomes.push(await alertMessage(config, text(row.id)).catch((error) => ({ outcome: "failed" as const, reason: error instanceof Error ? error.message : "" })));
  }
  return outcomes;
}

/** Configuration's "Send a test": the client's most recent reply, posted to the Slack test channel. */
export async function alertTest(config: Config, workspaceId: string): Promise<AlertOutcome> {
  const channel = (process.env[TEST_CHANNEL_ENV] ?? "").trim();
  if (!channel) return { outcome: "failed", reason: `${TEST_CHANNEL_ENV} is not set, so there is no test channel to post to.` };
  const conversations = await rows(config, `rr_conversations?select=id&workspace_id=eq.${enc(workspaceId)}&order=last_message_at.desc.nullslast&limit=40`);
  if (!conversations.length) return { outcome: "skipped", reason: "This client has no conversations yet." };
  const [latest] = await rows(
    config,
    `rr_messages?select=id&conversation_id=in.(${conversations.map((row) => text(row.id)).join(",")})&direction=eq.inbound&order=sent_at.desc&limit=1`,
  );
  if (!latest) return { outcome: "skipped", reason: "This client has no replies yet." };
  return alertMessage(config, text(latest.id), { test: true, channel });
}

type SendClaimResult = { verdict: "take"; token: string } | { verdict: "sent" | "busy" | "error" };

/** One send per alert, claimed the same way as the post. */
async function claimSend(config: Config, key: string, userId: string, now = Date.now()): Promise<SendClaimResult> {
  const token = randomUUID();
  const value: SendClaim = { status: "sending", token, at: new Date(now).toISOString(), by: userId };
  const inserted = await rest(config, "rr_app_config", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ key, value }) });
  if (inserted.ok) return { verdict: "take", token };
  if (inserted.status !== 409) return { verdict: "error" };
  const existing = (await readConfigValue(config, key)) as SendClaim | null;
  const verdict = sendClaimVerdict(existing, now);
  if (verdict !== "take" || !existing) return { verdict: verdict === "take" ? "busy" : verdict };
  return (await swapConfigValue(config, key, existing.token, value)) ? { verdict: "take", token } : { verdict: "busy" };
}

/**
 * The Send Reply button. Runs in `after()`, so Slack has had its 200 already; every way this can end
 * tells the person who pressed it, because otherwise a refusal looks exactly like a hang.
 */
export async function sendReplyFromSlack(action: Row): Promise<void> {
  const container = object(action.container);
  const channel = text(object(action.channel).id) || text(container.channel_id);
  const user = text(object(action.user).id);
  const message = object(action.message);
  const threadMessageTs = text(message.ts) || text(container.message_ts);
  const cardTs = text(message.thread_ts) || text(container.thread_ts);
  if (!channel || !user) return;
  const tell = (note: string) => postEphemeral(channel, user, note, cardTs).catch(() => undefined);

  const pressed = object((Array.isArray(action.actions) ? action.actions : [])[0]);
  const value = parseSendValue(pressed.value);
  if (!value) return tell("This button is missing its reply. Nothing was sent.");
  if (value.test) return tell("Test post. Nothing was sent.");
  const draft = draftFromState(action.state);
  const check = sendableCheck(draft);
  if (!check.ok) return tell(check.reason);
  const config = supabaseConfig();
  if (!config) return tell("Supabase is not configured, so nothing was sent.");

  try {
    const stored = dedupeMessages(await rows(config, `rr_messages?select=id,conversation_id,direction,body,sent_at,raw_data&conversation_id=eq.${enc(value.conversationId)}&order=sent_at.asc,id.asc&limit=500`));
    const latestInbound = [...stored].reverse().find((row) => row.direction === "inbound");
    if (!latestInbound) return tell("That conversation is no longer stored. Nothing was sent.");
    // An older card, or a reply already answered from the inbox: the lead has heard from us since.
    const answered = stored.some((row) => row.direction === "outbound" && Date.parse(text(row.sent_at)) > Date.parse(text(latestInbound.sent_at)));
    if (answered) return tell("We already replied after the lead's latest message. Nothing was sent. Follow up from the inbox.");

    const claimKey = `reply_alert_send:${value.messageId}`;
    const claim = await claimSend(config, claimKey, user);
    if (claim.verdict !== "take") {
      return tell({
        sent: "This reply was already sent. Nothing was sent again.",
        busy: "This reply is already being sent.",
        error: "Could not check whether this reply was already sent, so nothing was sent. Try again.",
      }[claim.verdict]);
    }

    const name = (await resolveUserNames([user]).catch(() => new Map<string, string>())).get(user) || "";
    const result = await sendConversationReply(config, { conversationId: value.conversationId, message: draft, source: "slack_reply_alert", actor: name || "Slack" });
    if (!result.ok) {
      // Nothing reached the lead (or the send's own lock is holding it), so the button is left for another try.
      await rest(config, `rr_app_config?key=eq.${enc(claimKey)}&value->>token=eq.${enc(claim.token)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return tell(`Not sent. ${result.error ?? "The outreach platform did not accept it."}`);
    }
    const at = new Date(result.sentAt || Date.now());
    await swapConfigValue(config, claimKey, claim.token, { status: "sent", token: claim.token, at: at.toISOString(), by: user }).catch(() => false);
    await mirrorAlert(config, value.messageId, { sent_at: at.toISOString(), sent_by: user, sent_by_name: name, sent_text: draft }).catch(() => undefined);
    await updateMessage(channel, threadMessageTs, `Reply sent by ${name || "a teammate"}`, sentThreadBlocks(message.blocks, { userId: user, message: draft, at })).catch(() => undefined);
    if (cardTs) await addReaction(channel, cardTs, "white_check_mark").catch(() => undefined);
  } catch (error) {
    await tell(`Not sent. ${error instanceof Error ? error.message : "Something went wrong."}`);
  }
}

/**
 * "Retry missed": every reply inside the window that failed to post (most often because QC Bot was not in
 * the replies channel), posted again now. Replies that were posted, or skipped on purpose, are left alone.
 */
export async function alertRetryMissed(config: Config, workspaceId: string): Promise<{ retried: number; posted: number; reason?: string }> {
  const workspace = await loadWorkspace(config, workspaceId);
  if (!workspace || !alertsOn(workspace)) return { retried: 0, posted: 0, reason: "Reply alerts are off for this client." };
  const since = new Date(windowStart(workspace, Date.now())).toISOString();
  const conversations = await rows(config, `rr_conversations?select=id&workspace_id=eq.${enc(workspaceId)}&last_message_at=gte.${enc(since)}&limit=500`);
  if (!conversations.length) return { retried: 0, posted: 0 };
  const missed: string[] = [];
  for (let i = 0; i < conversations.length; i += 40) {
    const batch = conversations.slice(i, i + 40).map((row) => text(row.id)).join(",");
    const found = await rows(config, `rr_messages?select=id,alert:raw_data->reply_radar->reply_alert&conversation_id=in.(${batch})&direction=eq.inbound&sent_at=gte.${enc(since)}&order=sent_at.asc&limit=100`);
    for (const row of found) {
      const alert = object(row.alert);
      if (text(alert.error) && !text(alert.posted_at)) missed.push(text(row.id));
    }
  }
  let posted = 0;
  let reason = "";
  for (const id of missed.slice(0, 20)) {
    const outcome = await alertMessage(config, id, { retry: true }).catch((error) => ({ outcome: "failed" as const, reason: error instanceof Error ? error.message : "" }));
    if (outcome.outcome === "posted") posted += 1;
    else if (outcome.reason) reason = outcome.reason;
  }
  return { retried: Math.min(missed.length, 20), posted, ...(reason ? { reason } : {}) };
}
