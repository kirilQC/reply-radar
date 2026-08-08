import { fetchFullConversation, type ConversationMessage, type JsonObject } from "./heyreach-conversation";
import { enrichLeadWithAiArk } from "./ai-ark-enrichment";

type SupabaseConfig = { url: string; key: string };

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

async function db(config: SupabaseConfig, path: string, options: RequestInit = {}) {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json", ...(options.headers ?? {}) },
    cache: "no-store",
  });
  const body = await response.text();
  let data: unknown = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) throw new Error(`Supabase ${path.split("?")[0]} ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

async function upsertOne(config: SupabaseConfig, table: string, filter: string, record: JsonObject) {
  const existing = await db(config, `${table}?select=id&${filter}&limit=1`) as JsonObject[];
  if (existing[0]?.id) {
    const rows = await db(config, `${table}?id=eq.${encodeURIComponent(String(existing[0].id))}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(record) }) as JsonObject[];
    return rows[0];
  }
  const rows = await db(config, table, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(record) }) as JsonObject[];
  return rows[0];
}

async function writeMessageChunks(config: SupabaseConfig, records: JsonObject[]) {
  for (let index = 0; index < records.length; index += 200) {
    await db(config, "rr_messages?on_conflict=conversation_id,heyreach_message_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(records.slice(index, index + 200)),
    });
  }
}

const fingerprint = (message: { direction: unknown; sent_at: unknown; body: unknown }) => `${String(message.direction)}|${new Date(String(message.sent_at)).toISOString()}|${String(message.body)}`;

export async function ingestHeyReachWebhook(config: SupabaseConfig, workspace: { id: string; heyreach_api_key_ciphertext?: string | null; guardrails?: JsonObject | null }, payload: JsonObject) {
  const lead = object(payload.lead);
  const campaign = object(payload.campaign);
  // Enrichment deliberately happens before the webhook event, lead, conversation,
  // or messages are persisted. A failed history lookup cannot create a partial inbox row.
  const history = await fetchFullConversation(text(workspace.heyreach_api_key_ciphertext), payload);
  const conversationExternalId = history.conversationExternalId || text(payload.conversation_id) || text(payload.correlation_id);
  const leadExternalId = text(lead.id) || text(lead.profile_url) || text(lead.email_address) || conversationExternalId;
  const eventType = text(payload.event_type) || text(payload.eventType) || "unknown";
  const eventTimestamp = text(payload.timestamp) || new Date().toISOString();
  const eventKey = text(payload.correlation_id) || `${conversationExternalId || leadExternalId}:${eventTimestamp}`;
  if (!conversationExternalId || !leadExternalId) throw new Error("HeyReach payload is missing conversation_id and lead identity fields.");

  const existingLeads = await db(config, `rr_leads?select=id,raw_data&workspace_id=eq.${encodeURIComponent(workspace.id)}&linkedin_id=eq.${encodeURIComponent(leadExternalId)}&limit=1`) as JsonObject[];
  const existingRaw = object(existingLeads[0]?.raw_data);
  const existingMetadata = object(existingRaw.reply_radar);
  const cachedEnrichment = object(existingMetadata.ai_ark);
  const enrichmentEnabled = workspace.guardrails?.ai_ark_enrichment_enabled === true;
  const profileUrl = text(lead.profile_url);
  const aiArk = Object.keys(cachedEnrichment).length
    ? cachedEnrichment
    : enrichmentEnabled && profileUrl
      ? await enrichLeadWithAiArk(config, workspace.id, profileUrl, text(lead.company_name))
      : null;

  const eventRows = await db(config, "rr_webhook_events?on_conflict=workspace_id,event_key", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ workspace_id: workspace.id, event_key: eventKey, event_type: eventType, raw: payload, status: "processing", error_text: null }),
  }) as JsonObject[];
  const eventId = eventRows?.[0]?.id;

  try {
    const leadRow = await upsertOne(config, "rr_leads", `workspace_id=eq.${encodeURIComponent(workspace.id)}&linkedin_id=eq.${encodeURIComponent(leadExternalId)}`, { workspace_id: workspace.id, linkedin_id: leadExternalId, linkedin_profile_url: text(lead.profile_url) || null, name: text(lead.full_name) || [text(lead.first_name), text(lead.last_name)].filter(Boolean).join(" ") || "Unknown lead", role: text(lead.position), company: text(lead.company_name), raw_data: { ...existingRaw, ...lead, campaign, reply_radar: { ...existingMetadata, sender: history.sender, campaign, history_fetched_at: history.fetchedAt, conversation: history.conversationSummary, ...(aiArk ? { ai_ark: aiArk } : {}) } } });
    const leadId = String(leadRow?.id ?? "");
    if (!leadId) throw new Error("Lead upsert returned no id.");

    const latestMessage = history.messages.at(-1);
    const lastMessageAt = latestMessage?.sentAt || eventTimestamp;
    const conversationRow = await upsertOne(config, "rr_conversations", `workspace_id=eq.${encodeURIComponent(workspace.id)}&heyreach_conversation_id=eq.${encodeURIComponent(conversationExternalId)}`, { workspace_id: workspace.id, lead_id: leadId, heyreach_conversation_id: conversationExternalId, account_id: history.sender.id || null, last_message_at: lastMessageAt, last_message_direction: latestMessage?.direction || "inbound" });
    const conversationId = String(conversationRow?.id ?? "");
    if (!conversationId) throw new Error("Conversation upsert returned no id.");

    const existing = await db(config, `rr_messages?select=heyreach_message_id,direction,body,sent_at&conversation_id=eq.${encodeURIComponent(conversationId)}`) as JsonObject[];
    const existingByFingerprint = new Map(existing.map((message) => [fingerprint(message as { direction: unknown; sent_at: unknown; body: unknown }), text(message.heyreach_message_id)]));
    const messages = history.messages.map((message: ConversationMessage) => ({
      conversation_id: conversationId,
      heyreach_message_id: existingByFingerprint.get(fingerprint({ direction: message.direction, sent_at: message.sentAt, body: message.body })) || message.externalId,
      direction: message.direction,
      body: message.body,
      sent_at: message.sentAt,
      raw_data: message.raw,
    }));
    await writeMessageChunks(config, messages);

    if (eventId) await db(config, `rr_webhook_events?id=eq.${encodeURIComponent(String(eventId))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "processed", processed_at: new Date().toISOString(), error_text: null }) });
    await db(config, `rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_webhook_received_at: new Date().toISOString() }) });
    return { eventId, leadId, conversationId, messagesWritten: messages.length, senderName: history.sender.name, campaignName: text(campaign.name) || null, aiArk: aiArk ? (Object.keys(cachedEnrichment).length ? "cached" : "enriched") : enrichmentEnabled ? "no_profile_url" : "disabled", historyFetchedAt: history.fetchedAt };
  } catch (error) {
    if (eventId) await db(config, `rr_webhook_events?id=eq.${encodeURIComponent(String(eventId))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", processed_at: new Date().toISOString(), error_text: error instanceof Error ? error.message.slice(0, 2_000) : "Ingestion failed" }) }).catch(() => null);
    throw error;
  }
}
