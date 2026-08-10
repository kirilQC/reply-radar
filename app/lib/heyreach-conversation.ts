import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;
export type ConversationMessage = {
  externalId: string;
  direction: "inbound" | "outbound";
  body: string;
  sentAt: string;
  raw: JsonObject;
};

type Sender = { id: string; name: string };
type HistoryResult = {
  conversationExternalId: string;
  messages: ConversationMessage[];
  sender: Sender;
  fetchedAt: string;
  conversationSummary: JsonObject;
  campaign: { id: string; name: string };
};

const apiBase = process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public";
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const first = (row: JsonObject, keys: string[]) => keys.map((key) => row[key]).find((value) => value !== undefined && value !== null && value !== "");
const iso = (value: unknown, fallback: string) => {
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

function campaignFrom(value: unknown) {
  const seen = new Set<unknown>();
  let fallback = { id: "", name: "" };
  const visit = (current: unknown, depth: number): { id: string; name: string } | null => {
    if (!current || depth > 7 || seen.has(current)) return null;
    if (typeof current === "object") seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) {
        const found = visit(item, depth + 1);
        if (found?.name) return found;
        if (found?.id && !fallback.id) fallback = found;
      }
      return null;
    }
    if (typeof current !== "object") return null;
    const row = current as JsonObject;
    const scalarEntries = Object.entries(row).filter(([, child]) => child == null || ["string", "number"].includes(typeof child));
    const campaignScalar = (suffixes: string[]) => {
      const match = scalarEntries.find(([key]) => {
        const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
        return suffixes.some((suffix) => normalized.endsWith(suffix));
      });
      return text(match?.[1]);
    };
    // HeyReach also exposes attribution as autoTagCampaignName / auto-tag
    // campaign fields, rather than only under a `campaign` object.
    const directName = text(first(row, ["campaignName", "campaign_name", "campaignTitle", "campaign_title"])) || campaignScalar(["campaignname", "campaigntitle"]);
    const directId = text(first(row, ["campaignId", "campaign_id"])) || campaignScalar(["campaignid"]);
    if (directName) return { id: directId, name: directName };
    if (directId && !fallback.id) fallback = { id: directId, name: "" };
    for (const [key, child] of Object.entries(row)) {
      if (/campaign/i.test(key) && child && typeof child === "object") {
        const campaign = object(child);
        const name = text(first(campaign, ["name", "title", "campaignName", "campaign_name"]));
        const id = text(first(campaign, ["id", "campaignId", "campaign_id"]));
        if (name) return { id, name };
        if (id && !fallback.id) fallback = { id, name: "" };
      }
    }
    for (const child of Object.values(row)) {
      const found = visit(child, depth + 1);
      if (found?.name) return found;
      if (found?.id && !fallback.id) fallback = found;
    }
    return null;
  };
  return visit(value, 0) ?? fallback;
}

function senderFromPayload(payload: JsonObject): Sender {
  const sender = object(payload.sender);
  return {
    id: text(sender.id),
    name: text(sender.full_name) || text(sender.fullName) || [text(sender.first_name ?? sender.firstName), text(sender.last_name ?? sender.lastName)].filter(Boolean).join(" ") || "Unknown sender",
  };
}

export function isHeyReachValidationPayload(payload: JsonObject) {
  const lead = object(payload.lead);
  const leadId = text(lead.id).toLowerCase();
  // HeyReach's "Test Webhook" button sends a synthetic lead whose account and
  // conversation do not exist in the customer's inbox. It is only an endpoint
  // reachability check, so attempting GetConversationsV2 will always return 400.
  return leadId === "testid";
}

function messageArrays(root: unknown) {
  const candidates: JsonObject[][] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || depth > 6 || seen.has(value)) return;
    if (typeof value === "object") seen.add(value);
    if (Array.isArray(value)) {
      const rows = value.map(object).filter((row) => Object.keys(row).length);
      const looksLikeMessages = rows.some((row) => first(row, ["message", "body", "text", "content", "messageText", "messageBody", "message_type", "messageType"]) !== undefined);
      if (looksLikeMessages) candidates.push(rows);
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === "object") Object.values(value as JsonObject).forEach((item) => visit(item, depth + 1));
  };
  visit(root, 0);
  return candidates.sort((a, b) => b.length - a.length)[0] ?? [];
}

function directionFor(row: JsonObject, accountId: string): "inbound" | "outbound" {
  if (typeof row.is_reply === "boolean") return row.is_reply ? "inbound" : "outbound";
  if (typeof row.isReply === "boolean") return row.isReply ? "inbound" : "outbound";
  for (const key of ["isFromMe", "fromMe", "sentByMe", "isSender", "isOutbound"]) {
    if (typeof row[key] === "boolean") return row[key] ? "outbound" : "inbound";
  }
  const direction = text(first(row, ["direction", "messageDirection", "senderType", "authorType", "sender", "type"])).toLowerCase();
  if (["outbound", "sent", "sender", "account", "me"].some((part) => direction.includes(part))) return "outbound";
  if (["inbound", "received", "reply", "lead", "participant", "correspondent"].some((part) => direction.includes(part))) return "inbound";
  const sender = object(first(row, ["sender", "author", "from"]));
  const messageSenderId = text(first(row, ["senderId", "sender_id", "linkedInAccountId", "accountId"])) || text(first(sender, ["id", "accountId", "linkedInAccountId"]));
  return messageSenderId && messageSenderId === accountId ? "outbound" : "inbound";
}

export function normalizeHeyReachMessages(rawMessages: unknown[], accountId: string, sender: Sender, fallbackTimestamp: string, source: "history" | "webhook") {
  return rawMessages.map(object).map((row) => {
    const direction = directionFor(row, accountId);
    const sentAt = iso(first(row, ["creation_time", "creationTime", "createdAt", "sentAt", "timestamp", "date"]), fallbackTimestamp);
    const messageType = text(first(row, ["message_type", "messageType", "contentType", "type"]));
    const body = text(first(row, ["message", "body", "text", "content", "messageText", "messageBody"])) || (messageType ? `[${messageType}]` : "[Empty message]");
    const suppliedId = text(first(row, ["id", "messageId", "message_id", "linkedinMessageId", "linkedInMessageId"]));
    const externalId = suppliedId || `rr-${digest(`${direction}|${sentAt}|${body}`)}`;
    return { externalId, direction, body, sentAt, raw: { ...row, reply_radar: { source, sender } } } satisfies ConversationMessage;
  });
}

export function mergeConversationMessages(history: ConversationMessage[], recent: ConversationMessage[]) {
  const byFingerprint = new Map<string, ConversationMessage>();
  for (const message of [...history, ...recent]) {
    const fingerprint = `${message.direction}|${message.sentAt}|${message.body}`;
    const current = byFingerprint.get(fingerprint);
    byFingerprint.set(fingerprint, current ? { ...message, externalId: current.externalId, raw: { ...current.raw, webhook_message: message.raw, reply_radar: message.raw.reply_radar } } : message);
  }
  return [...byFingerprint.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
}

async function heyReach(apiKey: string, path: string, init: RequestInit) {
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/${path.replace(/^\//, "")}`, {
    ...init,
    headers: { "X-API-KEY": apiKey, accept: "application/json", "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HeyReach ${path.split("?")[0]} returned ${response.status}.`);
  return response.json().catch(() => null) as Promise<unknown>;
}

async function campaignForLead(apiKey: string, lead: JsonObject, eventTimestamp: string) {
  try {
    const response = await heyReach(apiKey, "campaign/GetCampaignsForLead", {
      method: "POST",
      body: JSON.stringify({
        email: text(lead.email_address ?? lead.emailAddress),
        linkedinId: text(lead.id ?? lead.linkedinId ?? lead.linkedin_id),
        profileUrl: text(lead.profile_url ?? lead.profileUrl),
        offset: 0,
        limit: 100,
      }),
    });
    const root = object(response);
    const rows = Array.isArray(root.items) ? root.items.map(object) : Array.isArray(response) ? response.map(object) : [];
    const eventTime = new Date(eventTimestamp).getTime();
    const eligible = rows.filter((row) => {
      const created = new Date(text(first(row, ["creationTime", "createdAt", "creation_time"]))).getTime();
      return Number.isNaN(created) || Number.isNaN(eventTime) || created <= eventTime;
    });
    const selected = (eligible.length ? eligible : rows).sort((a, b) => {
      const aTime = new Date(text(first(a, ["creationTime", "createdAt", "creation_time"]))).getTime() || 0;
      const bTime = new Date(text(first(b, ["creationTime", "createdAt", "creation_time"]))).getTime() || 0;
      return bTime - aTime;
    })[0];
    return selected ? campaignFrom(selected) : { id: "", name: "" };
  } catch {
    // Campaign attribution must never prevent a valid reply from being stored.
    return { id: "", name: "" };
  }
}

export async function fetchFullConversation(apiKey: string, payload: JsonObject): Promise<HistoryResult> {
  const sender = senderFromPayload(payload);
  const lead = object(payload.lead);
  const leadProfileUrl = text(lead.profile_url ?? lead.profileUrl);
  const eventTimestamp = iso(payload.timestamp, new Date().toISOString());
  if (!apiKey) throw new Error("The workspace does not have a HeyReach API key configured.");
  if (!sender.id) throw new Error("The HeyReach webhook is missing the sender account id required for conversation enrichment.");
  if (!leadProfileUrl) throw new Error("The HeyReach webhook is missing the lead LinkedIn profile URL required for conversation enrichment.");

  const accountId = /^\d+$/.test(sender.id) ? Number(sender.id) : sender.id;
  const listResponse = await heyReach(apiKey, "inbox/GetConversationsV2", {
    method: "POST",
    body: JSON.stringify({ offset: 0, limit: 100, filters: { linkedInAccountIds: [accountId], leadProfileUrl } }),
  });
  const listObject = object(listResponse);
  const items = Array.isArray(listResponse) ? listResponse.map(object) : (Array.isArray(listObject.items) ? listObject.items.map(object) : []);
  if (!items.length) throw new Error("HeyReach returned no conversation for this sender and lead profile.");
  const webhookConversationId = text(payload.conversation_id ?? payload.conversationId);
  const conversation = items.find((item) => text(first(item, ["id", "conversationId", "conversation_id", "linkedInConversationId"])) === webhookConversationId) ?? items[0];
  const conversationExternalId = text(first(conversation, ["id", "conversationId", "conversation_id", "linkedInConversationId"])) || webhookConversationId;
  if (!conversationExternalId) throw new Error("HeyReach conversation lookup returned an item without a conversation id.");
  const linkedInAccount = object(first(conversation, ["linkedInAccount", "linkedinAccount", "account", "sender"]));
  const resolvedSender = sender.name !== "Unknown sender" ? sender : {
    id: sender.id,
    name: text(first(linkedInAccount, ["fullName", "full_name", "name"])) || [text(linkedInAccount.firstName ?? linkedInAccount.first_name), text(linkedInAccount.lastName ?? linkedInAccount.last_name)].filter(Boolean).join(" ") || sender.name,
  };

  let historyPayload: unknown = conversation;
  try {
    historyPayload = await heyReach(apiKey, `inbox/GetChatroom/${encodeURIComponent(sender.id)}/${encodeURIComponent(conversationExternalId)}`, { method: "GET" });
  } catch (error) {
    if (!messageArrays(conversation).length) throw error;
  }
  const history = normalizeHeyReachMessages(messageArrays(historyPayload), resolvedSender.id, resolvedSender, eventTimestamp, "history");
  const recentRows = Array.isArray(payload.recent_messages) ? payload.recent_messages : Array.isArray(payload.recentMessages) ? payload.recentMessages : [];
  const recent = normalizeHeyReachMessages(recentRows, resolvedSender.id, resolvedSender, eventTimestamp, "webhook");
  const suppliedCampaign = object(payload.campaign);
  const webhookCampaign = {
    id: text(first(suppliedCampaign, ["id", "campaignId", "campaign_id"])),
    name: text(first(suppliedCampaign, ["name", "title", "campaignName", "campaign_name"])),
  };
  const embeddedCampaign = campaignFrom([payload, conversation, historyPayload]);
  const resolvedCampaign = webhookCampaign.name
    ? webhookCampaign
    : embeddedCampaign.name
      ? embeddedCampaign
      : await campaignForLead(apiKey, lead, eventTimestamp);
  return { conversationExternalId, messages: mergeConversationMessages(history, recent), sender: resolvedSender, fetchedAt: new Date().toISOString(), conversationSummary: conversation, campaign: resolvedCampaign };
}
