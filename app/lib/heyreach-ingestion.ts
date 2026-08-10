import { conversationFromWebhook, fetchFullConversation, type ConversationMessage, type JsonObject } from "./heyreach-conversation";
import { enrichLeadWithAiArk } from "./ai-ark-enrichment";
import { isAiArkEnrichmentEnabled, leadRollup, mergeLeadAttributions } from "./lead-identity";
import { writeAuditEvent } from "./audit-log";
import { normalizePersonName } from "./person-name";

type SupabaseConfig = { url: string; key: string };

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const normalizedProfileUrl = (value: unknown) => text(value).toLowerCase().replace(/\?.*$/, "").replace(/\/$/, "");

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

async function upsertByConflict(config: SupabaseConfig, table: string, conflict: string, record: JsonObject) {
  const rows = await db(config, `${table}?on_conflict=${encodeURIComponent(conflict)}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(record),
  }) as JsonObject[];
  return rows[0];
}

async function saveLead(config: SupabaseConfig, existingId: string, record: JsonObject) {
  if (existingId) {
    const rows = await db(config, `rr_leads?id=eq.${encodeURIComponent(existingId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(record),
    }) as JsonObject[];
    return rows[0];
  }
  const rows = await db(config, "rr_leads", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(record),
  }) as JsonObject[];
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

async function findCachedEnrichment(config: SupabaseConfig, profileUrl: string, currentRaw: JsonObject) {
  const normalized = normalizedProfileUrl(profileUrl);
  const isReusable = (value: JsonObject) => Number(value.schemaVersion) >= 2 && normalizedProfileUrl(value.profileLinkedInUrl) === normalized;
  const current = object(object(currentRaw.reply_radar).ai_ark);
  if (Object.keys(current).length && isReusable(current)) return current;
  if (!normalized) return null;
  // AI Ark data describes the person, not a client's campaign. Reuse only that
  // enrichment fragment across tenant-scoped lead rows; never copy client data.
  const candidates = await db(config, `rr_leads?select=raw_data&linkedin_profile_url=eq.${encodeURIComponent(normalized)}&limit=10`) as JsonObject[];
  for (const candidate of candidates) {
    const enrichment = object(object(object(candidate.raw_data).reply_radar).ai_ark);
    if (Object.keys(enrichment).length && isReusable(enrichment)) return enrichment;
  }
  return null;
}

async function syncIdentityRollup(config: SupabaseConfig, profileUrl: string) {
  if (!profileUrl) return;
  const rows = await db(config, `rr_leads?select=id,workspace_id,raw_data&linkedin_profile_url=eq.${encodeURIComponent(profileUrl)}&limit=100`) as JsonObject[];
  const workspaceIds = [...new Set(rows.map((row) => text(row.workspace_id)).filter(Boolean))];
  const workspaces = workspaceIds.length ? await db(config, `rr_workspaces?select=id,name,slug&id=in.(${workspaceIds.join(",")})`) as JsonObject[] : [];
  const workspaceById = new Map(workspaces.map((row) => [text(row.id), text(row.name) || text(row.slug)]));
  const allAttributions = rows.flatMap((row) => {
    const metadata = object(object(row.raw_data).reply_radar);
    const stored = Array.isArray(metadata.attributions) ? metadata.attributions.map(object) : [];
    const workspaceId = text(row.workspace_id);
    if (stored.some((item) => text(item.workspaceId) === workspaceId)) return stored;
    const legacySender = object(metadata.sender);
    const legacyCampaign = object(metadata.campaign);
    const legacyConversation = object(metadata.conversation);
    return [...stored, { workspaceId, workspaceName: workspaceById.get(workspaceId) || workspaceId, conversationId: text(legacyConversation.id) || null, campaignId: text(legacyCampaign.id) || null, campaignName: text(legacyCampaign.name) || null, senderId: text(legacySender.id) || null, senderName: text(legacySender.name) || null }];
  });
  const deduped = allAttributions.reduce<JsonObject[]>((result, attribution) => mergeLeadAttributions(result, attribution), []);
  const rollup = leadRollup(deduped);
  for (const row of rows) {
    const raw = object(row.raw_data);
    const metadata = object(raw.reply_radar);
    await db(config, `rr_leads?id=eq.${encodeURIComponent(text(row.id))}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ raw_data: { ...raw, client_names: rollup.client_names, campaign_names: rollup.campaign_names, sender_names: rollup.sender_names, client_count: rollup.client_count, campaign_count: rollup.campaign_count, conversation_count: rollup.conversation_count, reply_radar: { ...metadata, attributions: deduped, rollup } } }),
    });
  }
}

const fingerprint = (message: { direction: unknown; sent_at: unknown; body: unknown }) => `${String(message.direction)}|${new Date(String(message.sent_at)).toISOString()}|${String(message.body)}`;

export async function ingestHeyReachWebhook(config: SupabaseConfig, workspace: { id: string; name?: string | null; slug?: string | null; heyreach_api_key_ciphertext?: string | null }, payload: JsonObject) {
  const lead = object(payload.lead);
  const webhookCampaign = object(payload.campaign);
  const suppliedConversationId = text(payload.conversation_id) || text(payload.correlation_id);
  const suppliedLeadId = text(lead.id) || normalizedProfileUrl(lead.profile_url) || text(lead.email_address);
  const eventType = text(payload.event_type) || text(payload.eventType) || "unknown";
  const eventTimestamp = text(payload.timestamp) || new Date().toISOString();
  const eventKey = text(payload.correlation_id) || `${suppliedConversationId || suppliedLeadId || "unknown"}:${eventTimestamp}`;

  const eventRows = await db(config, "rr_webhook_events?on_conflict=workspace_id,event_key", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ workspace_id: workspace.id, event_key: eventKey, event_type: eventType, raw: payload, status: "processing", error_text: null }),
  }) as JsonObject[];
  const eventId = eventRows?.[0]?.id;

  try {
    let historyError = "";
    const history = await fetchFullConversation(text(workspace.heyreach_api_key_ciphertext), payload).catch((error) => {
      historyError = error instanceof Error ? error.message : "HeyReach conversation history was unavailable";
      return conversationFromWebhook(payload);
    });
    const campaign = {
      ...webhookCampaign,
      ...(history.campaign.id ? { id: history.campaign.id } : {}),
      ...(history.campaign.name ? { name: history.campaign.name } : {}),
    };
    const conversationExternalId = history.conversationExternalId || suppliedConversationId;
    const profileUrl = normalizedProfileUrl(lead.profile_url);
    const existingByProfile = profileUrl ? await db(config, `rr_leads?select=id,linkedin_id,role,company,raw_data&workspace_id=eq.${encodeURIComponent(workspace.id)}&linkedin_profile_url=eq.${encodeURIComponent(profileUrl)}&limit=1`) as JsonObject[] : [];
    const existingByLeadId = !existingByProfile[0] && suppliedLeadId ? await db(config, `rr_leads?select=id,linkedin_id,role,company,raw_data&workspace_id=eq.${encodeURIComponent(workspace.id)}&linkedin_id=eq.${encodeURIComponent(suppliedLeadId)}&limit=1`) as JsonObject[] : [];
    const existingLead = existingByProfile[0] ?? existingByLeadId[0];
    const leadExternalId = text(existingLead?.linkedin_id) || profileUrl || suppliedLeadId || conversationExternalId;
    if (!conversationExternalId || !leadExternalId) throw new Error("HeyReach payload is missing conversation_id and lead identity fields.");
    const existingRaw = object(existingLead?.raw_data);
    const existingMetadata = object(existingRaw.reply_radar);
    const cachedEnrichment = await findCachedEnrichment(config, profileUrl, existingRaw);
    const enrichmentEnabled = isAiArkEnrichmentEnabled();
    let enrichmentError = "";
    const aiArk = cachedEnrichment
      ? cachedEnrichment
      : enrichmentEnabled && profileUrl
        ? await enrichLeadWithAiArk(config, workspace.id, profileUrl, text(lead.company_name)).catch((error) => {
            enrichmentError = error instanceof Error ? error.message : "AI Ark enrichment failed";
            return null;
          })
        : null;

    const priorAttributions = Array.isArray(existingMetadata.attributions) ? existingMetadata.attributions.map(object) : [];
    const campaignId = text(campaign.id);
    const campaignName = text(campaign.name);
    const matchingAttribution = priorAttributions.find((item) =>
      text(item.workspaceId) === workspace.id &&
      text(item.conversationId) === conversationExternalId &&
      (campaignId
        ? text(item.campaignId) === campaignId || (!text(item.campaignId) && !text(item.campaignName))
        : text(item.campaignName) === campaignName || (!text(item.campaignId) && !text(item.campaignName))) &&
      text(item.senderId) === text(history.sender.id),
    );
    const conversationAlreadyAttributed = priorAttributions.some((item) => text(item.workspaceId) === workspace.id && text(item.conversationId) === conversationExternalId);
    const storageConversationId = matchingAttribution
      ? text(matchingAttribution.storageConversationId) || conversationExternalId
      : conversationAlreadyAttributed
        ? `${conversationExternalId}::${campaignId || campaignName || "no-campaign"}::${history.sender.id || "unknown-sender"}`
        : conversationExternalId;
    const attribution = { workspaceId: workspace.id, workspaceName: text(workspace.name) || text(workspace.slug) || workspace.id, conversationId: conversationExternalId, storageConversationId, campaignId: campaignId || null, campaignName: campaignName || null, senderId: history.sender.id || null, senderName: history.sender.name, lastSeenAt: eventTimestamp };
    const priorAttributionsWithoutPlaceholder = priorAttributions.filter((item) => !(
      text(item.workspaceId) === workspace.id &&
      text(item.conversationId) === conversationExternalId &&
      text(item.senderId) === text(history.sender.id) &&
      !text(item.campaignId) &&
      !text(item.campaignName) &&
      (campaignId || campaignName)
    ));
    const stableMetadata = { ...existingMetadata };
    delete stableMetadata.sender;
    delete stableMetadata.campaign;
    delete stableMetadata.conversation;
    const stableRaw = { ...existingRaw };
    if (!text(object(stableRaw.campaign).name) && text(campaign.name)) stableRaw.campaign = campaign;
    const aiArkCompany = object(object(aiArk?.company).summary);
    const positionGroups = Array.isArray(aiArk?.positionGroups) ? aiArk.positionGroups.map(object) : [];
    const currentPositionCompany = object(positionGroups.find((group) => !text(object(group.date).end))?.company);
    const resolvedCompany = text(lead.company_name) || text(aiArkCompany.name) || text(currentPositionCompany.name) || text(existingLead?.company);
    const suppliedName = text(lead.full_name) || [text(lead.first_name), text(lead.last_name)].filter(Boolean).join(" ");
    const leadRow = await saveLead(config, text(existingLead?.id), { workspace_id: workspace.id, linkedin_id: leadExternalId, linkedin_profile_url: profileUrl || null, name: normalizePersonName(suppliedName), role: text(lead.position) || text(existingLead?.role), company: resolvedCompany, raw_data: { ...stableRaw, ...lead, full_name: normalizePersonName(suppliedName), company_name: resolvedCompany || null, profile_url: profileUrl || text(lead.profile_url) || null, reply_radar: { ...stableMetadata, history_fetched_at: history.fetchedAt, history_status: historyError ? "webhook_fallback" : "complete", ...(historyError ? { history_error: historyError.slice(0, 1_000) } : {}), attributions: mergeLeadAttributions(priorAttributionsWithoutPlaceholder, attribution), enrichment_status: aiArk ? "enriched" : enrichmentEnabled ? "unavailable" : "disabled", ...(enrichmentError ? { enrichment_error: enrichmentError.slice(0, 1_000) } : {}), ...(aiArk ? { ai_ark: aiArk } : {}) } } });
    const leadId = String(leadRow?.id ?? "");
    if (!leadId) throw new Error("Lead upsert returned no id.");
    await syncIdentityRollup(config, profileUrl);

    const latestMessage = history.messages.at(-1);
    const lastMessageAt = latestMessage?.sentAt || eventTimestamp;
    const conversationRow = await upsertByConflict(config, "rr_conversations", "workspace_id,heyreach_conversation_id", { workspace_id: workspace.id, lead_id: leadId, heyreach_conversation_id: storageConversationId, account_id: history.sender.id || null, last_message_at: lastMessageAt, last_message_direction: latestMessage?.direction || "inbound" });
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
      raw_data: { ...message.raw, reply_radar: { ...object(message.raw.reply_radar), sender: history.sender, campaign, conversation: { id: conversationExternalId, accountId: history.sender.id } } },
    }));
    await writeMessageChunks(config, messages);

    if (eventId) await db(config, `rr_webhook_events?id=eq.${encodeURIComponent(String(eventId))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "processed", processed_at: new Date().toISOString(), error_text: null }) });
    await db(config, `rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_webhook_received_at: new Date().toISOString() }) });
    await writeAuditEvent(config, { actor: "Supabase", action: "conversation.stored", entityType: "conversation", entityId: conversationId, details: { source: "supabase", status: "success", workspaceId: workspace.id, workspaceName: text(workspace.name) || text(workspace.slug), leadId, eventId, messagesWritten: messages.length, summary: `Supabase updated the lead and saved ${messages.length} message${messages.length === 1 ? "" : "s"} with the full conversation context.` } });
    return { eventId, leadId, conversationId, messagesWritten: messages.length, senderName: history.sender.name, campaignName: text(campaign.name) || null, aiArk: aiArk ? (cachedEnrichment ? "cached" : "enriched") : enrichmentEnabled ? "unavailable" : "disabled", enrichmentError: enrichmentError || null, history: historyError ? "webhook_fallback" : "complete", historyError: historyError || null, historyFetchedAt: history.fetchedAt };
  } catch (error) {
    if (eventId) await db(config, `rr_webhook_events?id=eq.${encodeURIComponent(String(eventId))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", processed_at: new Date().toISOString(), error_text: error instanceof Error ? error.message.slice(0, 2_000) : "Ingestion failed" }) }).catch(() => null);
    throw error;
  }
}
