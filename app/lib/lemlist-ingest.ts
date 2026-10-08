// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * lemlist replies into the inbox: the same lead / conversation / message rows a HeyReach or Email Bison reply
 * makes. A lemlist campaign writes to a lead by email and on LinkedIn, so each contact can have up to two
 * conversations, keyed `lemlist:<contact id>:email` and `lemlist:<contact id>:linkedin`, with
 * rr_conversations.channel set to match. Nothing keyed `lemlist:` is ever sent to HeyReach.
 *
 * ── The thread ──────────────────────────────────────────────────────────────────────────────────
 * lemlist's inbox gives a contact's whole history in one call (/inbox/{contactId}): our campaign steps
 * (emailsSent, linkedinSent, the invite note) as outbound and their answers (emailsReplied, linkedinReplied)
 * as inbound. Out-of-office and other automatic emails are dropped, exactly as for Email Bison.
 *
 * ── Trust ───────────────────────────────────────────────────────────────────────────────────────
 * A webhook body is only read for the contact id: the thread is fetched from lemlist with the client's own
 * key, so a forged webhook cannot plant a reply.
 */

import { isOurCampaign } from "../../shared/campaign-code.mjs";
import { isAutoReply } from "../../shared/email-text.mjs";
import { lemlistBody } from "../../shared/lemlist-text.mjs";
import {
  findInHeyReach,
  findLinkedInLead,
  findViaAiArk,
  leadForHeyReachProfile,
  rememberEmail,
  upgradeEmailLead,
  type Config,
  type PersonForMatch,
} from "./email-ingest";
import { addHook, contactMessages, deleteHook, getContact, getTeam, listCampaigns, listHooks, replyActivities, sendEmail, sendLinkedIn, LemlistError } from "./lemlist";

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const enc = encodeURIComponent;

async function rest(config: Config, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  }).catch(() => null);
  if (!response) return { ok: false, status: 0, data: null };
  const body = await response.text().catch(() => "");
  let data: unknown = body;
  try { data = body ? JSON.parse(body) : null; } catch { /* keep text */ }
  return { ok: response.ok, status: response.status, data };
}
async function rows(config: Config, path: string): Promise<Row[]> {
  const result = await rest(config, path);
  if (!result.ok) throw new Error(`Supabase ${path.split("?")[0]} ${result.status}: ${String(typeof result.data === "string" ? result.data : JSON.stringify(result.data)).slice(0, 200)}`);
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

export type LemlistWorkspace = {
  id: string; name: string; slug: string; offboarded_at?: string | null;
  lemlist_api_key?: string | null; lemlist_team_id?: string | null; lemlist_team_name?: string | null;
  lemlist_webhook_ids?: string[] | null; lemlist_webhook_secret?: string | null; lemlist_synced_at?: string | null;
};
export const LEMLIST_WORKSPACE_COLUMNS = "id,name,slug,offboarded_at,lemlist_api_key,lemlist_team_id,lemlist_team_name,lemlist_webhook_ids,lemlist_webhook_secret,lemlist_synced_at";

export type LemlistChannel = "email" | "linkedin";
export const lemlistConversationKey = (contactId: string, channel: LemlistChannel) => `lemlist:${contactId}:${channel}`;
export const isLemlistConversationKey = (key: unknown) => String(key ?? "").startsWith("lemlist:");
export function parseLemlistKey(key: unknown): { contactId: string; channel: LemlistChannel } | null {
  const match = /^lemlist:([^:]+):(email|linkedin)$/.exec(String(key ?? ""));
  return match ? { contactId: match[1], channel: match[2] as LemlistChannel } : null;
}

/** Which channel and direction a lemlist inbox message is, or null for anything that is not a message. */
const KIND: Record<string, { channel: LemlistChannel; direction: "inbound" | "outbound" }> = {
  emailsSent: { channel: "email", direction: "outbound" },
  emailsReplied: { channel: "email", direction: "inbound" },
  linkedinSent: { channel: "linkedin", direction: "outbound" },
  linkedinInviteDone: { channel: "linkedin", direction: "outbound" },
  linkedinReplied: { channel: "linkedin", direction: "inbound" },
};
export const channelOfActivity = (type: unknown): LemlistChannel | null => KIND[text(type)]?.channel ?? null;

const bodyOf = (message: Row, direction: "inbound" | "outbound"): string => lemlistBody(message, direction);

/** Campaign names per key, cached ten minutes: the thread carries campaign ids, the code rule needs names. */
const campaignCache = new Map<string, { at: number; names: Map<string, string> }>();
async function campaignNames(apiKey: string): Promise<Map<string, string>> {
  const cached = campaignCache.get(apiKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.names;
  const names = new Map((await listCampaigns(apiKey)).map((row) => [row.id, row.name]));
  campaignCache.set(apiKey, { at: Date.now(), names });
  return names;
}

/** A lemlist contact as the lead matcher reads it. */
function personOf(contact: Row | null, hint: Row): PersonForMatch & { title: string; linkedinUrl: string } {
  const fields = object(contact?.fields);
  const linkedinUrl = text(fields.linkedinUrl) || text(contact?.linkedinUrl) || text(hint.linkedinUrl);
  const name = text(contact?.fullName) || [text(fields.firstName) || text(hint.firstName) || text(hint.leadFirstName), text(fields.lastName) || text(hint.lastName) || text(hint.leadLastName)].filter(Boolean).join(" ");
  const email = (text(contact?.email) || text(hint.email) || text(hint.leadEmail)).toLowerCase();
  return {
    email,
    name: name || email,
    company: text(fields.companyName) || text(hint.companyName) || text(hint.leadCompanyName),
    title: text(fields.jobTitle) || text(hint.jobTitle),
    linkedinUrl,
    linkedinHandle: (linkedinUrl.match(/linkedin\.com\/in\/([^/?#\s]+)/i)?.[1] ?? "").toLowerCase(),
  };
}

/**
 * The lead row for a lemlist contact: their LinkedIn lead when QC has one (by profile URL, email, then name),
 * one already made for this contact, a lead built from the LinkedIn URL lemlist holds, the person found in the
 * client's HeyReach lists, or else an email-only lead (which AI Ark then tries to put a LinkedIn profile on).
 */
async function findOrCreateLead(config: Config, workspaceId: string, contactId: string, person: ReturnType<typeof personOf>): Promise<string> {
  const ref = { lemlist: { contact_id: contactId } };
  const linked = await findLinkedInLead(config, workspaceId, person);
  if (linked) {
    await rememberEmail(config, linked, person.email, ref);
    return text(linked.id);
  }
  const seen = await rows(config, `rr_leads?select=id&workspace_id=eq.${enc(workspaceId)}&raw_data->reply_radar->lemlist->>contact_id=eq.${enc(contactId)}&limit=1`);
  if (seen[0]) return text(seen[0].id);
  if (person.email) {
    const emailOnly = await rows(config, `rr_leads?select=id&workspace_id=eq.${enc(workspaceId)}&raw_data->reply_radar->>email=eq.${enc(person.email)}&limit=1`);
    if (emailOnly[0]) return text(emailOnly[0].id);
  }
  const base = { email: person.email || null, full_name: person.name, company_name: person.company || null };
  if (person.linkedinUrl) {
    const created = await rest(config, "rr_leads", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ workspace_id: workspaceId, linkedin_profile_url: person.linkedinUrl, name: person.name, role: person.title || null, company: person.company || null, raw_data: { ...base, profile_url: person.linkedinUrl, reply_radar: { ...(person.email ? { email: person.email } : {}), history_status: "complete", ...ref, attribution: { source: "lemlist" } } } }),
    });
    const row = Array.isArray(created.data) ? (created.data[0] as Row | undefined) : undefined;
    if (created.ok && row) return text(row.id);
  }
  const fromHeyReach = await findInHeyReach(config, workspaceId, person).catch(() => null);
  if (fromHeyReach) return leadForHeyReachProfile(config, workspaceId, fromHeyReach, person, ref);
  const created = await rest(config, "rr_leads", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ workspace_id: workspaceId, name: person.name, role: person.title || null, company: person.company || null, raw_data: { ...base, reply_radar: { email: person.email, channel: "email", history_status: "complete", ...ref } } }),
  });
  const row = Array.isArray(created.data) ? (created.data[0] as Row | undefined) : undefined;
  if (!created.ok || !row) throw new Error(`Could not save the lemlist lead (${created.status}).`);
  if (person.email) {
    const viaAiArk = await findViaAiArk(config, workspaceId, person).catch(() => null);
    if (viaAiArk) await upgradeEmailLead(config, row, viaAiArk).catch(() => undefined);
  }
  return text(row.id);
}

export type LemlistIngestResult = { discarded: true; reason: string; campaignName?: string } | { conversationId: string; leadId: string; messagesWritten: number; campaignName: string; channel: LemlistChannel };

/**
 * One contact's thread on one channel, read from lemlist with the client's key, into the inbox. Kept only when
 * it answers one of our (coded) campaigns and holds at least one reply a person wrote.
 */
export async function ingestLemlistContact(config: Config, workspace: LemlistWorkspace, contactId: string, channel: LemlistChannel, hint: Row = {}): Promise<LemlistIngestResult> {
  const apiKey = text(workspace.lemlist_api_key);
  if (!apiKey) return { discarded: true, reason: "no_lemlist_key" };
  if (!contactId) return { discarded: true, reason: "no_contact" };
  const history = (await contactMessages(apiKey, contactId)).filter((message) => KIND[text(message.type)]?.channel === channel);
  const conversationKey = lemlistConversationKey(contactId, channel);

  const names = await campaignNames(apiKey).catch(() => new Map<string, string>());
  const campaignId = [...history].reverse().map((message) => text(message.campaignId)).find(Boolean) || text(hint.campaignId);
  const campaignName = names.get(campaignId) || [...history].reverse().map((message) => text(message.campaignName)).find(Boolean) || text(hint.campaignName);
  // The same rule as LinkedIn and Email Bison: a campaign without a QC code is the client's own outreach.
  if (!campaignId) return { discarded: true, reason: "no_campaign" };
  if (!isOurCampaign(campaignName)) return { discarded: true, reason: "not_our_campaign", campaignName };

  const theirs = history.filter((message) => KIND[text(message.type)].direction === "inbound");
  const isAuto = (message: Row) => channel === "email" && isAutoReply({ subject: text(message.subject), text_body: bodyOf(message, "inbound") });
  const human = theirs.filter((message) => !isAuto(message));
  if (!human.length) {
    // Nothing but auto-replies (or no reply at all): no conversation, and one stored before is removed.
    await rest(config, `rr_conversations?workspace_id=eq.${enc(workspace.id)}&heyreach_conversation_id=eq.${enc(conversationKey)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return { discarded: true, reason: theirs.length ? "automated" : "no_reply" };
  }

  const contact = await getContact(apiKey, contactId).catch(() => null);
  const leadId = await findOrCreateLead(config, workspace.id, contactId, personOf(contact, hint));
  const campaign = { id: campaignId, name: campaignName, source: "lemlist" };
  const automatedIds = theirs.filter(isAuto).map((message) => `lemlist:${text(message._id)}`);
  const messages = history
    .filter((message) => !isAuto(message) && text(message._id) && text(message.createdAt))
    .map((message) => {
      const direction = KIND[text(message.type)].direction;
      return {
        heyreach_message_id: `lemlist:${text(message._id)}`,
        direction,
        body: bodyOf(message, direction),
        sent_at: text(message.createdAt),
        raw_data: {
          channel,
          subject: text(message.subject) || undefined,
          reply_radar: {
            channel,
            campaign: text(message.campaignId) ? { ...campaign, id: text(message.campaignId), name: names.get(text(message.campaignId)) || campaignName } : campaign,
            ...(direction === "outbound" ? { sender: { id: text(message.sendUserId), name: text(message.sendUserName) || text(message.sendUserEmail) } } : { automated: false }),
            lemlist: { activity_id: text(message._id), type: text(message.type), contact_id: contactId, lead_id: text(message.leadId), send_user_id: text(message.sendUserId), send_user_email: text(message.sendUserEmail), send_user_mailbox_id: text(message.sendUserMailboxId) },
          },
        },
      };
    })
    .filter((message) => message.body || message.direction === "inbound")
    .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));

  const last = messages[messages.length - 1];
  const conversation = await rest(config, "rr_conversations?on_conflict=workspace_id,heyreach_conversation_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      workspace_id: workspace.id,
      lead_id: leadId,
      heyreach_conversation_id: conversationKey,
      account_id: [...history].reverse().map((message) => text(message.sendUserId)).find(Boolean) || null,
      channel,
      last_message_at: last?.sent_at ?? new Date().toISOString(),
      last_message_direction: last?.direction ?? "inbound",
      // Read from lemlist just now: the inbox footer says when, instead of "Not yet synced".
      last_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  const conversationRow = Array.isArray(conversation.data) ? (conversation.data[0] as Row | undefined) : undefined;
  if (!conversation.ok || !conversationRow) throw new Error(`Could not save the lemlist conversation (${conversation.status}): ${JSON.stringify(conversation.data).slice(0, 200)}`);
  const conversationId = text(conversationRow.id);

  if (automatedIds.length) {
    await rest(config, `rr_messages?conversation_id=eq.${enc(conversationId)}&heyreach_message_id=in.(${automatedIds.map((id) => enc(`"${id}"`)).join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  if (messages.length) {
    const written = await rest(config, "rr_messages?on_conflict=conversation_id,heyreach_message_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(messages.map((message) => ({ conversation_id: conversationId, ...message }))),
    });
    if (!written.ok) throw new Error(`Could not save the lemlist messages (${written.status}).`);
  }
  return { conversationId, leadId, messagesWritten: messages.length, campaignName, channel };
}

/**
 * The backup to the webhooks, and the first backfill: reply activities since the last sync (two days at most
 * on a routine pass, `days` on a backfill), each contact's thread ingested once per channel.
 */
export async function syncLemlistReplies(config: Config, workspace: LemlistWorkspace, days = 0): Promise<{ checked: number; ingested: string[]; skipped: Record<string, number> }> {
  const apiKey = text(workspace.lemlist_api_key);
  if (!apiKey) return { checked: 0, ingested: [], skipped: { no_lemlist_key: 1 } };
  const now = Date.now();
  const last = Date.parse(text(workspace.lemlist_synced_at));
  const since = new Date(days > 0 ? now - days * 86_400_000 : Number.isNaN(last) ? now - 14 * 86_400_000 : Math.max(last - 15 * 60_000, now - 2 * 86_400_000)).toISOString();
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const ingested: string[] = [];
  let checked = 0;
  const done = new Set<string>();
  for (const type of ["emailsReplied", "linkedinReplied"] as const) {
    const activities = await replyActivities(apiKey, type, since, days > 0 ? 20 : 5);
    checked += activities.length;
    for (const activity of activities) {
      const contactId = text(activity.contactId);
      const channel = channelOfActivity(activity.type) ?? (type === "emailsReplied" ? "email" : "linkedin");
      if (!contactId) { skip("no_contact"); continue; }
      if (activity.isThirdPartyReply === true) { skip("third_party"); continue; }
      const key = `${contactId}:${channel}`;
      if (done.has(key)) continue;
      done.add(key);
      const stored = await rows(config, `rr_messages?select=id&heyreach_message_id=eq.${enc(`lemlist:${text(activity._id)}`)}&limit=1`);
      if (stored[0] && days <= 0) continue;
      const result = await ingestLemlistContact(config, workspace, contactId, channel, activity).catch((error) => { skip(`error: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); return null; });
      if (result && "conversationId" in result) ingested.push(result.conversationId);
      // A skipped campaign is named, so the Configuration panel says which lemlist campaigns lack a QC code.
      else if (result && "reason" in result) skip(result.reason === "not_our_campaign" ? `not our campaign: ${result.campaignName || "unnamed"}` : result.reason);
    }
  }
  await rest(config, `rr_workspaces?id=eq.${enc(workspace.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ lemlist_synced_at: new Date(now).toISOString() }) });
  return { checked, ingested: [...new Set(ingested)], skipped };
}

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Our answer to a lemlist conversation, sent through lemlist on the conversation's channel: email threaded
 * onto the lead's latest reply from the mailbox that wrote to them, LinkedIn from the same lemlist user.
 * Stored as the outbound message it is. The inbox and the Slack Send button both come here for `lemlist:`.
 */
export async function sendLemlistConversationReply(config: Config, conversationId: string, message: string): Promise<{ ok: boolean; status: number; error?: string; sentAt?: string }> {
  const [conversation] = await rows(config, `rr_conversations?select=id,workspace_id,heyreach_conversation_id&id=eq.${enc(conversationId)}&limit=1`);
  const parsed = parseLemlistKey(conversation?.heyreach_conversation_id);
  if (!conversation || !parsed) return { ok: false, status: 404, error: "That lemlist conversation no longer exists." };
  const [workspace] = await rows(config, `rr_workspaces?select=${LEMLIST_WORKSPACE_COLUMNS}&id=eq.${enc(text(conversation.workspace_id))}&limit=1`);
  const apiKey = text(workspace?.lemlist_api_key);
  if (!apiKey) return { ok: false, status: 409, error: "This client has no lemlist API key saved." };
  const stored = await rows(config, `rr_messages?select=direction,raw_data,sent_at&conversation_id=eq.${enc(conversationId)}&order=sent_at.desc&limit=50`);
  const meta = (row: Row | undefined) => object(object(object(row?.raw_data).reply_radar).lemlist);
  const latestInbound = meta(stored.find((row) => row.direction === "inbound"));
  const sender = meta(stored.find((row) => row.direction === "outbound" && text(meta(row).send_user_id)));
  if (!text(sender.send_user_id)) return { ok: false, status: 409, error: "Could not tell which lemlist sender wrote to this lead." };
  try {
    if (parsed.channel === "email") {
      if (!text(sender.send_user_email) || !text(sender.send_user_mailbox_id)) return { ok: false, status: 409, error: "Could not tell which lemlist mailbox wrote to this lead." };
      await sendEmail(apiKey, {
        sendUserId: text(sender.send_user_id),
        sendUserEmail: text(sender.send_user_email),
        sendUserMailboxId: text(sender.send_user_mailbox_id),
        contactId: parsed.contactId,
        replyToActivityId: text(latestInbound.activity_id) || "latest",
        html: escapeHtml(message).split(/\n{2,}/).map((part) => `<p>${part.replace(/\n/g, "<br>")}</p>`).join(""),
      });
    } else {
      const leadId = text(latestInbound.lead_id) || stored.map((row) => text(meta(row).lead_id)).find(Boolean) || "";
      if (!leadId) return { ok: false, status: 409, error: "Could not find the lemlist lead for this conversation." };
      await sendLinkedIn(apiKey, { sendUserId: text(sender.send_user_id), leadId, contactId: parsed.contactId, message });
    }
  } catch (error) {
    return { ok: false, status: 502, error: `lemlist did not send it: ${error instanceof Error ? error.message : "unknown error"}` };
  }
  const sentAt = new Date().toISOString();
  await rest(config, "rr_messages?on_conflict=conversation_id,heyreach_message_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ conversation_id: conversationId, heyreach_message_id: `lemlist:manual:${Date.now()}`, direction: "outbound", body: message, sent_at: sentAt, raw_data: { channel: parsed.channel, reply_radar: { channel: parsed.channel, sent_from: "qc_command", lemlist: { ...sender, activity_id: "" } } } }),
  });
  await rest(config, `rr_conversations?id=eq.${enc(conversationId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_message_at: sentAt, last_message_direction: "outbound", updated_at: sentAt }) });
  return { ok: true, status: 200, sentAt };
}

/** The inbox's refresh for a lemlist thread: the contact's history re-read from lemlist. */
export async function refreshLemlistConversation(config: Config, conversationId: string): Promise<{ messagesUpdated: number; error?: string }> {
  const [conversation] = await rows(config, `rr_conversations?select=id,workspace_id,heyreach_conversation_id&id=eq.${enc(conversationId)}&limit=1`);
  const parsed = parseLemlistKey(conversation?.heyreach_conversation_id);
  if (!conversation || !parsed) return { messagesUpdated: 0, error: "Conversation not found" };
  const [workspace] = await rows(config, `rr_workspaces?select=${LEMLIST_WORKSPACE_COLUMNS}&id=eq.${enc(text(conversation.workspace_id))}&limit=1`);
  if (!workspace) return { messagesUpdated: 0, error: "The client is gone." };
  const result = await ingestLemlistContact(config, workspace as unknown as LemlistWorkspace, parsed.contactId, parsed.channel);
  if (!("conversationId" in result)) return { messagesUpdated: 0, error: result.reason };
  await rest(config, `rr_conversations?id=eq.${enc(conversationId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_refreshed_at: new Date().toISOString() }) });
  return { messagesUpdated: result.messagesWritten };
}

/**
 * Connects a client to lemlist with their API key: the key is checked against lemlist (and named by its team),
 * saved, QC's two reply webhooks (email, LinkedIn) are registered in the team, and the last 14 days of replies
 * are pulled in. Running it again with the same key re-registers the webhooks and syncs again.
 */
export async function connectLemlist(config: Config, workspace: LemlistWorkspace, apiKey: string, baseUrl: string): Promise<{ ok: boolean; error?: string; teamName?: string; webhooks?: number; sync?: Awaited<ReturnType<typeof syncLemlistReplies>> }> {
  const key = apiKey.trim() || text(workspace.lemlist_api_key);
  if (!key) return { ok: false, error: "Paste the client's lemlist API key." };
  let team: { id: string; name: string };
  try {
    team = await getTeam(key);
  } catch (error) {
    return { ok: false, error: error instanceof LemlistError && error.status === 401 ? "lemlist did not accept that API key." : `Could not reach lemlist: ${error instanceof Error ? error.message : "unknown error"}` };
  }
  const oldKey = text(workspace.lemlist_api_key);
  const { randomBytes } = await import("node:crypto");
  const secret = text(workspace.lemlist_webhook_secret) || randomBytes(18).toString("base64url");
  const urlFor = (channel: LemlistChannel) => `${baseUrl}/api/webhooks/lemlist/${enc(workspace.slug)}/${secret}?channel=${channel}`;

  // A new key for a different team: the old team's hooks are removed first (best effort).
  if (oldKey && oldKey !== key) {
    for (const id of workspace.lemlist_webhook_ids ?? []) await deleteHook(oldKey, id).catch(() => undefined);
  }
  const existing = await listHooks(key).catch(() => [] as Row[]);
  const hookIds: string[] = [];
  for (const [channel, type] of [["email", "emailsReplied"], ["linkedin", "linkedinReplied"]] as const) {
    const url = urlFor(channel);
    const found = existing.find((hook) => text(hook.targetUrl) === url && hook.disabled !== true);
    if (found) { hookIds.push(text(found._id)); continue; }
    const stale = existing.find((hook) => text(hook.targetUrl) === url);
    if (stale) await deleteHook(key, text(stale._id)).catch(() => undefined);
    try {
      hookIds.push(await addHook(key, url, type, secret));
    } catch (error) {
      return { ok: false, error: `The key works (${team.name}), but lemlist would not register the ${channel} webhook: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  }
  const patch = { lemlist_api_key: key, lemlist_team_id: team.id, lemlist_team_name: team.name, lemlist_webhook_ids: hookIds.filter(Boolean), lemlist_webhook_secret: secret };
  const saved = await rest(config, `rr_workspaces?id=eq.${enc(workspace.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  if (!saved.ok) return { ok: false, error: `Could not save the lemlist key (${saved.status}). Has the lemlist migration been run?` };
  const sync = await syncLemlistReplies(config, { ...workspace, ...patch }, 14).catch(() => undefined);
  return { ok: true, teamName: team.name, webhooks: hookIds.length, sync };
}

/** Removes QC's webhooks from the client's lemlist team and forgets the key. Stored conversations stay. */
export async function disconnectLemlist(config: Config, workspace: LemlistWorkspace): Promise<{ ok: boolean }> {
  const key = text(workspace.lemlist_api_key);
  if (key) for (const id of workspace.lemlist_webhook_ids ?? []) await deleteHook(key, id).catch(() => undefined);
  await rest(config, `rr_workspaces?id=eq.${enc(workspace.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ lemlist_api_key: null, lemlist_team_id: null, lemlist_team_name: null, lemlist_webhook_ids: null }) });
  return { ok: true };
}


/**
 * Read-only shape check for debugging (no message text leaves this): for a client's latest replies on each
 * channel, the field names of the activity and of every message in the contact's thread, with the length of
 * each string field. Used to find where lemlist keeps a reply's text when the inbox shows it empty.
 */
export async function diagnoseLemlistShapes(workspace: LemlistWorkspace, perType = 2): Promise<Row[]> {
  const apiKey = text(workspace.lemlist_api_key);
  if (!apiKey) return [];
  const shape = (row: Row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" ? `string(${value.length})` : Array.isArray(value) ? `array(${value.length})` : value && typeof value === "object" ? `object{${Object.keys(value).join(",")}}` : typeof value]));
  const out: Row[] = [];
  // Each replied-to campaign's name as a letter/digit pattern only ("AAA999: Aaaa"), and whether the QC code
  // rule accepts it: enough to see why replies are skipped without exposing any campaign name.
  const pattern = (name: string) => name.slice(0, 14).replace(/[A-Za-z]/g, "A").replace(/[0-9]/g, "9");
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const counts = new Map<string, { pattern: string; ours: boolean; replies: number }>();
  for (const type of ["linkedinReplied", "emailsReplied"] as const) {
    for (const activity of await replyActivities(apiKey, type, since, 3)) {
      const name = text(activity.campaignName);
      const entry = counts.get(name) ?? { pattern: pattern(name), ours: isOurCampaign(name), replies: 0 };
      entry.replies += 1;
      counts.set(name, entry);
    }
  }
  out.push({ campaigns: [...counts.values()].sort((a, b) => b.replies - a.replies) });
  // QC's webhooks in this lemlist team: event type and whether lemlist still delivers, never the URL (it holds the secret).
  const hooks = await listHooks(apiKey).catch(() => [] as Row[]);
  const secret = text(workspace.lemlist_webhook_secret);
  out.push({ hooks: hooks.filter((hook) => secret && text(hook.targetUrl).includes(secret)).map((hook) => ({ type: text(hook.type), disabled: hook.disabled === true, lastErrorStatus: hook.lastErrorStatus ?? null })), otherHooks: hooks.filter((hook) => !secret || !text(hook.targetUrl).includes(secret)).length });
  for (const type of ["linkedinReplied", "emailsReplied"] as const) {
    const activities = (await replyActivities(apiKey, type, since, 1)).slice(0, perType);
    for (const activity of activities) {
      const thread = await contactMessages(apiKey, text(activity.contactId)).catch(() => [] as Row[]);
      out.push({ type, activity: shape(activity), thread: thread.map(shape) });
    }
  }
  return out;
}
