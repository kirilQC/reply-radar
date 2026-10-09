// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Pushing a client's replies into their own CRM (HubSpot, Attio) or a Google Sheet: the part every destination
 * shares. Which conversations count, what one of them looks like as a record, and the bookkeeping that makes
 * a push idempotent (rr_crm_push_records: what each conversation became, and a hash of what was sent).
 *
 * ── Which replies ───────────────────────────────────────────────────────────────────────────────
 * Every channel (LinkedIn and email, from HeyReach, lemlist and Email Bison), only conversations the inbox
 * shows: a reply to one of our coded campaigns, never a lead who approached us first. A conversation with
 * nothing from the lead yet is not a reply and is not pushed.
 */

import { createHash } from "node:crypto";
import { isOurCampaign } from "../../shared/campaign-code.mjs";
import { classifyConversationOrigin } from "../../shared/conversation-origin.mjs";
import { dedupeMessages } from "./message-dedupe";
import { leadFromRow } from "./reply-alert";
import { canonicalLinkedin, conversationText as conversationTextImpl, linkedinKey } from "../../shared/crm-push-text.mjs";

export { linkedinKey };
/** The conversation as readable text for a destination (shared/crm-push-text.mjs). */
export const conversationText = (record: ReplyRecord, maxChars: number, format: "html" | "markdown" | "plain"): string => conversationTextImpl(record, maxChars, format);

type Row = Record<string, unknown>;
export type Config = { url: string; key: string };
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const enc = encodeURIComponent;

export async function rest(config: Config, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
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
export async function rows(config: Config, path: string): Promise<Row[]> {
  const result = await rest(config, path);
  if (!result.ok) throw new Error(`Supabase ${path.split("?")[0]} ${result.status}: ${String(typeof result.data === "string" ? result.data : JSON.stringify(result.data)).slice(0, 200)}`);
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

export type PushMessage = { direction: "inbound" | "outbound"; body: string; sentAt: string; author: string };

/** One conversation as a destination receives it. */
export type ReplyRecord = {
  conversationId: string;
  leadId: string;
  name: string;
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  domain: string;
  linkedinUrl: string;
  /** The stable LinkedIn key: the lower-cased /in/ slug (or the whole normalized URL when there is no slug). */
  linkedinId: string;
  /** The profile URL in the one form QC stores and matches on (https://www.linkedin.com/in/<slug>). */
  linkedinCanonical: string;
  companyLinkedinUrl: string;
  email: string;
  location: string;
  channel: "linkedin" | "email";
  platform: "HeyReach" | "lemlist" | "Email Bison";
  campaign: string;
  sender: string;
  sentiment: string;
  firstReplyAt: string;
  lastReplyAt: string;
  lastMessageAt: string;
  replyCount: number;
  latestReply: string;
  messages: PushMessage[];
  /** A hash of everything sent, so an unchanged conversation is skipped on the next push. */
  hash: string;
};

const platformOf = (key: string): ReplyRecord["platform"] => (key.startsWith("bison:") ? "Email Bison" : key.startsWith("lemlist:") ? "lemlist" : "HeyReach");

/**
 * The client's pushable conversations, newest first, as ReplyRecords. `since` narrows to conversations with
 * activity after that time (the automatic sync); `limit` caps one batch.
 */
export async function replyRecords(config: Config, workspaceId: string, opts: { since?: string; limit?: number; offset?: number } = {}): Promise<{ records: ReplyRecord[]; scanned: number }> {
  const limit = Math.min(opts.limit ?? 40, 100);
  const conversations = await rows(
    config,
    `rr_conversations?select=id,lead_id,channel,heyreach_conversation_id,last_message_at&workspace_id=eq.${enc(workspaceId)}${opts.since ? `&last_message_at=gte.${enc(opts.since)}` : ""}&order=last_message_at.desc,id.asc&offset=${opts.offset ?? 0}&limit=${limit}`,
  );
  if (!conversations.length) return { records: [], scanned: 0 };
  const leadIds = [...new Set(conversations.map((row) => text(row.lead_id)).filter(Boolean))];
  const [leads, messages] = await Promise.all([
    leadIds.length ? rows(config, `rr_leads?select=*&id=in.(${leadIds.map(enc).join(",")})`) : Promise.resolve([] as Row[]),
    rows(config, `rr_messages?select=id,conversation_id,direction,body,sent_at,raw_data&conversation_id=in.(${conversations.map((row) => enc(text(row.id))).join(",")})&order=sent_at.asc,id.asc&limit=5000`),
  ]);
  const leadById = new Map(leads.map((row) => [text(row.id), row]));
  const byConversation = new Map<string, Row[]>();
  for (const message of dedupeMessages(messages)) {
    const id = text(message.conversation_id);
    byConversation.set(id, [...(byConversation.get(id) ?? []), message]);
  }

  const records: ReplyRecord[] = [];
  for (const conversation of conversations) {
    const id = text(conversation.id);
    const lead = leadById.get(text(conversation.lead_id));
    const thread = byConversation.get(id) ?? [];
    if (!lead || !thread.some((message) => message.direction === "inbound")) continue;
    const radar = (message: Row) => object(object(message.raw_data).reply_radar);
    const campaign = [...thread].reverse().map((message) => text(object(radar(message).campaign).name)).find(Boolean) ?? "";
    // The inbox's own rules: our campaigns only, and never a lead who approached us.
    if (!isOurCampaign(campaign)) continue;
    if (classifyConversationOrigin({ messages: thread, leadRawData: lead.raw_data }).origin === "inbound_lead") continue;

    const card = leadFromRow(lead);
    const words = card.name.split(/\s+/).filter(Boolean);
    const inbound = thread.filter((message) => message.direction === "inbound");
    const lastInbound = inbound[inbound.length - 1];
    const sender = [...thread].reverse().map((message) => (message.direction === "outbound" ? text(object(radar(message).sender).name) : "")).find(Boolean) ?? "";
    const key = text(conversation.heyreach_conversation_id);
    const channel = text(conversation.channel) === "email" || key.startsWith("bison:") ? "email" : "linkedin";
    const pushMessages: PushMessage[] = thread.map((message) => ({
      direction: message.direction === "inbound" ? "inbound" : "outbound",
      body: text(message.body),
      sentAt: text(message.sent_at),
      author: message.direction === "inbound" ? card.name : text(object(radar(message).sender).name) || sender || "QC Growth",
    }));
    const base = {
      conversationId: id,
      leadId: text(lead.id),
      name: card.name,
      firstName: words[0] ?? "",
      lastName: words.slice(1).join(" "),
      title: card.title,
      company: card.company,
      domain: card.domain,
      linkedinUrl: card.linkedinUrl,
      linkedinId: linkedinKey(card.linkedinUrl),
      linkedinCanonical: canonicalLinkedin(card.linkedinUrl),
      companyLinkedinUrl: card.companyLinkedinUrl,
      email: card.email.toLowerCase(),
      location: card.location,
      channel: channel as ReplyRecord["channel"],
      platform: platformOf(key),
      campaign,
      sender,
      sentiment: text(radar(lastInbound ?? {}).sentiment).toLowerCase(),
      firstReplyAt: text(inbound[0]?.sent_at),
      lastReplyAt: text(lastInbound?.sent_at),
      lastMessageAt: text(conversation.last_message_at),
      replyCount: inbound.length,
      latestReply: text(lastInbound?.body),
      messages: pushMessages,
    };
    records.push({ ...base, hash: createHash("sha256").update(JSON.stringify(base)).digest("hex").slice(0, 32) });
  }
  return { records, scanned: conversations.length };
}

export type PushRecordRow = { conversation_id: string; contact_id: string | null; company_id: string | null; note_id: string | null; pushed_hash: string | null; created_contact: boolean };

export async function pushedRecords(config: Config, workspaceId: string, provider: string, conversationIds: string[]): Promise<Map<string, PushRecordRow>> {
  if (!conversationIds.length) return new Map();
  const found = await rows(config, `rr_crm_push_records?select=conversation_id,contact_id,company_id,note_id,pushed_hash,created_contact&workspace_id=eq.${enc(workspaceId)}&provider=eq.${enc(provider)}&conversation_id=in.(${conversationIds.map(enc).join(",")})`).catch(() => [] as Row[]);
  return new Map(found.map((row) => [text(row.conversation_id), row as unknown as PushRecordRow]));
}

export async function savePushRecord(config: Config, workspaceId: string, provider: string, record: { conversationId: string; contactId?: string | null; companyId?: string | null; noteId?: string | null; hash?: string | null; createdContact?: boolean; error?: string | null }): Promise<void> {
  await rest(config, "rr_crm_push_records?on_conflict=workspace_id,conversation_id,provider", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      workspace_id: workspaceId,
      conversation_id: record.conversationId,
      provider,
      contact_id: record.contactId ?? null,
      company_id: record.companyId ?? null,
      note_id: record.noteId ?? null,
      created_contact: record.createdContact ?? false,
      pushed_hash: record.error ? null : record.hash ?? null,
      pushed_at: new Date().toISOString(),
      error: record.error ?? null,
    }),
  });
}

// ── The destination row ─────────────────────────────────────────────────────────────────────────

export type Destination = {
  workspace_id: string;
  kind: "crm" | "sheets";
  provider: "hubspot" | "attio" | "google_sheets";
  api_key: string | null;
  account_id: string | null;
  account_name: string | null;
  status: string;
  audit: Row | null;
  plan: Row | null;
  build_log: Row[] | null;
  config: Row;
  auto_push: boolean;
  last_push_at: string | null;
  last_push_summary: Row | null;
};

export async function loadDestination(config: Config, workspaceId: string, kind: "crm" | "sheets"): Promise<Destination | null> {
  const [row] = await rows(config, `rr_crm_push?select=*&workspace_id=eq.${enc(workspaceId)}&kind=eq.${kind}&limit=1`);
  return (row as unknown as Destination) ?? null;
}

/**
 * Saves part of a destination. An existing row is PATCHed with just the changed columns; only a new one is
 * inserted. (An upsert of a partial row failed with 400: Postgres checks the insert's required columns,
 * like `provider`, before it ever looks for the existing row.)
 */
export async function saveDestination(config: Config, workspaceId: string, kind: "crm" | "sheets", patch: Partial<Destination>): Promise<void> {
  const body = JSON.stringify({ ...patch, updated_at: new Date().toISOString() });
  const updated = await rest(config, `rr_crm_push?workspace_id=eq.${enc(workspaceId)}&kind=eq.${kind}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body,
  });
  const fail = (result: { status: number; data: unknown }) => new Error(`Could not save the ${kind === "crm" ? "CRM" : "sheet"} settings (${result.status}): ${String(typeof result.data === "string" ? result.data : JSON.stringify(result.data)).slice(0, 200)}`);
  if (!updated.ok) throw fail(updated);
  if (Array.isArray(updated.data) && updated.data.length) return;
  const inserted = await rest(config, "rr_crm_push", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ workspace_id: workspaceId, kind, ...patch, updated_at: new Date().toISOString() }),
  });
  if (!inserted.ok) throw fail(inserted);
}

/** What the browser may see of a destination: never the key. */
export function presentDestination(destination: Destination | null) {
  if (!destination) return null;
  return {
    provider: destination.provider,
    connected: Boolean(destination.api_key),
    keyMasked: destination.api_key ? `••••${destination.api_key.slice(-4)}` : "",
    accountId: destination.account_id,
    accountName: destination.account_name,
    status: destination.status,
    audit: destination.audit,
    plan: destination.plan,
    buildLog: destination.build_log ?? [],
    config: destination.config ?? {},
    autoPush: destination.auto_push,
    lastPushAt: destination.last_push_at,
    lastPushSummary: destination.last_push_summary,
  };
}
