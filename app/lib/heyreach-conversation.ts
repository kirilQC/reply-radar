import { createHash } from "node:crypto";
import { NEAR_DUPLICATE_MS, directionFor, extractMessageRows, messageKey, syntheticMessageId } from "../../shared/message-identity.mjs";

// Re-exported so callers keep a single import for conversation handling.
export { NEAR_DUPLICATE_MS, directionFor, extractMessageRows, messageKey, syntheticMessageId };

export type JsonObject = Record<string, unknown>;
export type ConversationMessage = {
  externalId: string;
  direction: "inbound" | "outbound";
  body: string;
  sentAt: string;
  raw: JsonObject;
};

type Sender = { id: string; name: string };

/**
 * Where a campaign name came from, because that decides whether it is evidence or decoration.
 *
 * `webhook` — HeyReach's own webhook envelope named the campaign this reply belongs to.
 * `membership` — HeyReach confirmed the lead is enrolled in the campaign.
 * `derived` — the name was found somewhere in a conversation payload. Good enough to display, not
 *   good enough to conclude we ever contacted this person.
 *
 * Only the first two are trusted, and the distinction matters: attribution used to be synthesised
 * from whatever campaign the sending account happened to be running, which handed a campaign name
 * to people who had cold-messaged us out of nowhere. That fallback is gone, and the source is
 * recorded so nothing downstream has to take a bare name on faith again.
 */
export type CampaignSource = "" | "webhook" | "membership" | "derived";
export type CampaignAttribution = { id: string; name: string; source: CampaignSource };

/**
 * The company and title HeyReach itself knows about the lead.
 *
 * Enrichment is the better source when it works, but it does not always work, and a lead with no
 * company and no title on screen is worse than one carrying HeyReach's version of them — HeyReach has
 * both for every lead it imported. Collected here rather than read at the call site because the two
 * places a lead arrives from spell the same fields differently: the webhook envelope is snake_case
 * and the inbox API is camelCase, and reading only one of them is how these ended up blank.
 */
export type HeyReachLeadProfile = { company: string; role: string };

type HistoryResult = {
  conversationExternalId: string;
  messages: ConversationMessage[];
  sender: Sender;
  fetchedAt: string;
  conversationSummary: JsonObject;
  campaign: CampaignAttribution;
  leadProfile: HeyReachLeadProfile;
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

const COMPANY_KEYS = ["company_name", "companyName", "company", "current_company", "currentCompany", "organization"];
const ROLE_KEYS = ["position", "title", "job_title", "jobTitle", "headline", "occupation", "current_position", "currentPosition"];

/**
 * Reads company and title out of the webhook's lead and, failing that, out of the inbox record for the
 * same person. The conversation carries its own copy of the correspondent, which is the one that
 * survives when the webhook envelope is thin.
 */
export function heyReachLeadProfile(lead: JsonObject, conversationSummary: JsonObject): HeyReachLeadProfile {
  const correspondent = object(
    first(conversationSummary, ["correspondent", "correspondentProfile", "lead", "leadProfile", "profile"]),
  );
  const named = (keys: string[]) => {
    for (const source of [lead, correspondent]) {
      const value = first(source, keys);
      // A company can arrive as an object rather than a string, in which case its name is the field.
      const resolved = typeof value === "object" && value !== null ? text(first(object(value), ["name", "title"])) : text(value);
      if (resolved) return resolved;
    }
    return "";
  };
  return { company: named(COMPANY_KEYS), role: named(ROLE_KEYS) };
}

export function isHeyReachValidationPayload(payload: JsonObject) {
  const lead = object(payload.lead);
  const leadId = text(lead.id).toLowerCase();
  // HeyReach's "Test Webhook" button sends a synthetic lead whose account and
  // conversation do not exist in the customer's inbox. It is only an endpoint
  // reachability check, so attempting GetConversationsV2 will always return 400.
  return leadId === "testid";
}


export function normalizeHeyReachMessages(rawMessages: unknown[], accountId: string, sender: Sender, fallbackTimestamp: string, source: "history" | "webhook") {
  return rawMessages.map(object).map((row) => {
    const direction = directionFor(row, accountId);
    const sentAt = iso(first(row, ["creation_time", "creationTime", "createdAt", "sentAt", "timestamp", "date"]), fallbackTimestamp);
    const messageType = text(first(row, ["message_type", "messageType", "contentType", "type"]));
    const body = text(first(row, ["message", "body", "text", "content", "messageText", "messageBody"])) || (messageType ? `[${messageType}]` : "[Empty message]");
    const suppliedId = text(first(row, ["id", "messageId", "message_id", "linkedinMessageId", "linkedInMessageId"]));
    // The synthetic id must not depend on the direction, or re-classifying a message would
    // mint a new id and leave the original row behind as a duplicate.
    const externalId = suppliedId || syntheticMessageId(sentAt, body);
    return { externalId, direction, body, sentAt, raw: { ...row, reply_radar: { source, sender } } } satisfies ConversationMessage;
  });
}

/**
 * Folds the webhook's `recent_messages` into the authoritative chatroom history. The webhook
 * copy of a message does not always carry its own timestamp or `sender`, so the event time and
 * a guessed direction get substituted — matching on the direction and an exact timestamp would
 * therefore treat the same message as two, and show one of them as sent by the other party.
 * Matching on the body within a short window keeps a single, correctly attributed copy.
 */
export function mergeConversationMessages(history: ConversationMessage[], recent: ConversationMessage[]) {
  const merged = [...history];
  for (const message of recent) {
    const match = merged.findIndex(
      (candidate) =>
        candidate.body === message.body &&
        Math.abs(Date.parse(candidate.sentAt) - Date.parse(message.sentAt)) < NEAR_DUPLICATE_MS,
    );
    if (match >= 0) {
      merged[match] = { ...merged[match], raw: { ...merged[match].raw, webhook_message: message.raw } };
      continue;
    }
    merged.push(message);
  }
  return merged.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
}

export function conversationFromWebhook(payload: JsonObject): HistoryResult {
  const sender = senderFromPayload(payload);
  const lead = object(payload.lead);
  const eventTimestamp = iso(payload.timestamp, new Date().toISOString());
  const recentRows = Array.isArray(payload.recent_messages)
    ? payload.recent_messages
    : Array.isArray(payload.recentMessages)
      ? payload.recentMessages
      : [];
  const suppliedCampaign = object(payload.campaign);
  const envelope = {
    id: text(first(suppliedCampaign, ["id", "campaignId", "campaign_id"])),
    name: text(first(suppliedCampaign, ["name", "title", "campaignName", "campaign_name"])),
  };
  const campaign: CampaignAttribution = { ...envelope, source: envelope.id || envelope.name ? "webhook" : "" };
  const conversationExternalId =
    text(payload.conversation_id ?? payload.conversationId) ||
    text(payload.correlation_id ?? payload.correlationId) ||
    `webhook-${digest(`${text(lead.id)}|${text(lead.profile_url)}|${eventTimestamp}`)}`;
  return {
    conversationExternalId,
    messages: normalizeHeyReachMessages(
      recentRows,
      sender.id,
      sender,
      eventTimestamp,
      "webhook",
    ),
    sender,
    fetchedAt: new Date().toISOString(),
    conversationSummary: {},
    campaign,
    leadProfile: heyReachLeadProfile(lead, {}),
  };
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

function newestEligibleCampaign(rows: JsonObject[], eventTimestamp: string) {
  const eventTime = new Date(eventTimestamp).getTime();
  const eligible = rows.filter((row) => {
    const created = new Date(text(first(row, ["creationTime", "createdAt", "creation_time"]))).getTime();
    return Number.isNaN(created) || Number.isNaN(eventTime) || created <= eventTime;
  });
  return (eligible.length ? eligible : rows).sort((a, b) => {
    const aTime = new Date(text(first(a, ["creationTime", "createdAt", "creation_time"]))).getTime() || 0;
    const bTime = new Date(text(first(b, ["creationTime", "createdAt", "creation_time"]))).getTime() || 0;
    return bTime - aTime;
  })[0];
}

/**
 * Asks HeyReach which of our campaigns this lead is actually enrolled in.
 *
 * An empty answer means an empty answer. This function used to fall back to `campaign/GetAll`
 * filtered by the sending account and pick that account's newest campaign — so a stranger who
 * cold-messaged one of our senders came out of here wearing the name of a campaign they had never
 * been in. That is where the phantom campaign names came from, and it also defeated every guard
 * downstream that read a campaign name as proof we had gone out and found the person.
 *
 * Returning nothing is the honest answer, and the caller is built to cope with it.
 */
async function campaignMembership(apiKey: string, lead: JsonObject, eventTimestamp: string): Promise<CampaignAttribution> {
  const none: CampaignAttribution = { id: "", name: "", source: "" };
  try {
    const identity = {
      email: text(lead.email_address ?? lead.emailAddress),
      linkedinId: text(lead.id ?? lead.linkedinId ?? lead.linkedin_id),
      profileUrl: text(lead.profile_url ?? lead.profileUrl),
    };
    const response = await heyReach(apiKey, "campaign/GetCampaignsForLead", {
      method: "POST",
      body: JSON.stringify({ ...Object.fromEntries(Object.entries(identity).filter(([, value]) => value)), offset: 0, limit: 100 }),
    });
    const root = object(response);
    const rows = Array.isArray(root.items) ? root.items.map(object) : Array.isArray(response) ? response.map(object) : [];
    const selected = newestEligibleCampaign(rows, eventTimestamp);
    if (!selected) return none;
    return {
      id: text(first(selected, ["campaignId", "campaign_id", "id"])),
      name: text(first(selected, ["campaignName", "campaign_name", "name", "title"])),
      source: "membership",
    };
  } catch {
    // Campaign attribution must never prevent a valid reply from being stored.
    return none;
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
    if (!extractMessageRows(conversation).length) throw error;
  }
  const history = normalizeHeyReachMessages(extractMessageRows(historyPayload), resolvedSender.id, resolvedSender, eventTimestamp, "history");
  const recentRows = Array.isArray(payload.recent_messages) ? payload.recent_messages : Array.isArray(payload.recentMessages) ? payload.recentMessages : [];
  const recent = normalizeHeyReachMessages(recentRows, resolvedSender.id, resolvedSender, eventTimestamp, "webhook");
  const suppliedCampaign = object(payload.campaign);
  const webhookCampaign = {
    id: text(first(suppliedCampaign, ["id", "campaignId", "campaign_id"])),
    name: text(first(suppliedCampaign, ["name", "title", "campaignName", "campaign_name"])),
  };
  // Membership is asked before the payload scan, not after it. The scan walks seven levels of the
  // chatroom looking for anything campaign-shaped, which finds names that belong to the account or
  // the inbox rather than to this lead — fine as a label, useless as evidence.
  const membership = webhookCampaign.name || webhookCampaign.id
    ? null
    : await campaignMembership(apiKey, lead, eventTimestamp);
  const embeddedCampaign = campaignFrom([payload, conversation, historyPayload]);
  const resolvedCampaign: CampaignAttribution = webhookCampaign.name || webhookCampaign.id
    ? { ...webhookCampaign, source: "webhook" }
    : membership?.name || membership?.id
      ? membership
      : embeddedCampaign.name || embeddedCampaign.id
        ? { ...embeddedCampaign, source: "derived" }
        : { id: "", name: "", source: "" };
  return { conversationExternalId, messages: mergeConversationMessages(history, recent), sender: resolvedSender, fetchedAt: new Date().toISOString(), conversationSummary: conversation, campaign: resolvedCampaign, leadProfile: heyReachLeadProfile(lead, conversation) };
}
