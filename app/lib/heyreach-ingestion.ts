type JsonObject = Record<string, unknown>;
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

export async function ingestHeyReachWebhook(config: SupabaseConfig, workspace: { id: string }, payload: JsonObject) {
  const lead = object(payload.lead);
  const campaign = object(payload.campaign);
  const recentMessages = Array.isArray(payload.recent_messages) ? payload.recent_messages.map(object) : [];
  const conversationExternalId = text(payload.conversation_id) || text(payload.correlation_id);
  const leadExternalId = text(lead.id) || text(lead.profile_url) || text(lead.email_address) || conversationExternalId;
  const eventType = text(payload.event_type) || text(payload.eventType) || "unknown";
  const eventTimestamp = text(payload.timestamp) || new Date().toISOString();
  const eventKey = text(payload.correlation_id) || `${conversationExternalId || leadExternalId}:${eventTimestamp}`;
  if (!conversationExternalId || !leadExternalId) throw new Error("HeyReach payload is missing conversation_id and lead identity fields.");

  const eventRows = await db(config, "rr_webhook_events?on_conflict=workspace_id,event_key", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ workspace_id: workspace.id, event_key: eventKey, event_type: eventType, raw: payload, status: "processing", error_text: null }),
  }) as JsonObject[];
  const eventId = eventRows?.[0]?.id;

  try {
    const leadRows = await db(config, "rr_leads?on_conflict=workspace_id,external_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ workspace_id: workspace.id, external_id: leadExternalId, name: text(lead.full_name) || [text(lead.first_name), text(lead.last_name)].filter(Boolean).join(" ") || "Unknown lead", title: text(lead.position), company: text(lead.company_name), profile_url: text(lead.profile_url) || null, raw_data: { ...lead, campaign } }),
    }) as JsonObject[];
    const leadId = String(leadRows[0]?.id ?? "");
    if (!leadId) throw new Error("Lead upsert returned no id.");

    const latestMessage = recentMessages.reduce<JsonObject | null>((latest, message) => !latest || text(message.creation_time) > text(latest.creation_time) ? message : latest, null);
    const lastMessageAt = text(latestMessage?.creation_time) || eventTimestamp;
    const conversationRows = await db(config, "rr_conversations?on_conflict=workspace_id,external_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ workspace_id: workspace.id, lead_id: leadId, external_id: conversationExternalId, last_message_at: lastMessageAt, last_message_direction: "inbound" }),
    }) as JsonObject[];
    const conversationId = String(conversationRows[0]?.id ?? "");
    if (!conversationId) throw new Error("Conversation upsert returned no id.");

    if (recentMessages.length) {
      const messages = recentMessages.map((message, index) => {
        const sentAt = text(message.creation_time) || eventTimestamp;
        const messageType = text(message.message_type);
        return { conversation_id: conversationId, external_id: `${eventKey}:${index}:${sentAt}`, direction: message.is_reply === false ? "outbound" : "inbound", body: text(message.message) || (messageType ? `[${messageType}]` : "[Empty message]"), sent_at: sentAt, raw_data: message };
      });
      await db(config, "rr_messages?on_conflict=conversation_id,external_id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(messages) });
    }

    if (eventId) await db(config, `rr_webhook_events?id=eq.${encodeURIComponent(String(eventId))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "processed", processed_at: new Date().toISOString(), error_text: null }) });
    await db(config, `rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_webhook_received_at: new Date().toISOString() }) });
    return { eventId, leadId, conversationId, messagesWritten: recentMessages.length };
  } catch (error) {
    if (eventId) await db(config, `rr_webhook_events?id=eq.${encodeURIComponent(String(eventId))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", processed_at: new Date().toISOString(), error_text: error instanceof Error ? error.message.slice(0, 2_000) : "Ingestion failed" }) }).catch(() => null);
    throw error;
  }
}
