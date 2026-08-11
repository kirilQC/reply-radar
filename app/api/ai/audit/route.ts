import { NextResponse } from "next/server";
import { queryByIds } from "../../../lib/chunk-query";

type Row = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : "");
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
// actor_id is free-form text in the audit table, so only pass through real ids.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Number(params.get("limit") || 200), 500);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  try {
    // Audit events are now persisted permanently — the draft feed is the source
    // of truth for what the assistant has produced, so we no longer purge on read.
    // Fetch general audit rows, workspace logos, and the dedicated draft slice in
    // parallel. The draft slice is filtered to the reply-drafting event types so
    // the feed can always show recent generations even when hundreds of sentiment
    // rows would otherwise push them out of the general 200-row window.
    const draftEventTypes = "conversation.analyzed,draft.generated,draft.failed";
    const [response, wsResponse, draftResponse] = await Promise.all([
      fetch(`${url}/rest/v1/rr_audit_log?select=*&actor_type=eq.anthropic&order=created_at.desc&limit=${limit}`, { headers, cache: "no-store" }),
      fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,logo_url`, { headers, cache: "no-store" }),
      fetch(`${url}/rest/v1/rr_audit_log?select=*&actor_type=eq.anthropic&event_type=in.(${draftEventTypes})&order=created_at.desc&limit=100`, { headers, cache: "no-store" }),
    ]);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Supabase ${response.status}: ${body.slice(0, 200)}`);
    }
    const generalRows = (await response.json()) as Row[];
    const draftOnlyRows = draftResponse.ok ? ((await draftResponse.json()) as Row[]) : [];
    // Combine both slices for enrichment (id de-dupe), then split back into
    // `events` (general log) and `drafts` (the feed) on the way out.
    const rowById = new Map<string, Row>();
    for (const row of generalRows) rowById.set(text(row.id), row);
    for (const row of draftOnlyRows) if (!rowById.has(text(row.id))) rowById.set(text(row.id), row);
    const rows = [...rowById.values()];
    const generalIds = new Set(generalRows.map((r) => text(r.id)));
    const draftIds = new Set(draftOnlyRows.map((r) => text(r.id)));
    const workspaces = wsResponse.ok ? ((await wsResponse.json()) as Row[]) : [];
    const wsLogoByName = new Map(workspaces.map((ws) => [text(ws.name).toLowerCase(), text(ws.logo_url)]));
    const wsLogoById = new Map(workspaces.map((ws) => [text(ws.id), text(ws.logo_url)]));

    // actor_id is whatever entity the action operated on, and that is not the same table for
    // every action: conversation-scoped work (sentiment, reply drafts, follow-up scores) records
    // a conversation id, while ICP scoring records the lead id directly. The audit table does not
    // persist the entity type, so an id is resolved against both tables and the resulting name
    // and photo are keyed by the audit row's own actor_id either way.
    const auditIds = [...new Set(rows.map((r) => text(r.actor_id)).filter((id) => UUID.test(id)))];
    const leadNameByAuditId = new Map<string, string>();
    const leadPhotoByAuditId = new Map<string, string>();

    const convRows = await queryByIds(auditIds, 40, async (batch) => {
      const res = await fetch(
        `${url}/rest/v1/rr_conversations?select=id,lead_id&id=in.(${batch.join(",")})`,
        { headers, cache: "no-store" },
      ).catch(() => null);
      return res?.ok ? ((await res.json().catch(() => [])) as Row[]) : [];
    });
    // Ids that matched no conversation are candidate lead ids, so look those up alongside the
    // leads reached through a conversation.
    const conversationIds = new Set(convRows.map((c) => text(c.id)));
    const leadIds = [
      ...new Set([
        ...convRows.map((c) => text(c.lead_id)),
        ...auditIds.filter((id) => !conversationIds.has(id)),
      ].filter((id) => UUID.test(id))),
    ];
    const leadRows = await queryByIds(leadIds, 40, async (batch) => {
      const res = await fetch(
        `${url}/rest/v1/rr_leads?select=id,name,raw_data&id=in.(${batch.join(",")})`,
        { headers, cache: "no-store" },
      ).catch(() => null);
      return res?.ok ? ((await res.json().catch(() => [])) as Row[]) : [];
    });
    const leadById = new Map(leadRows.map((l) => [text(l.id), l]));
    // Enrichment lives at raw_data.reply_radar.ai_ark
    const photoOf = (lead: Row) => {
      const enrichment = object(object(object(lead.raw_data).reply_radar).ai_ark);
      return text(enrichment.profilePhotoSource) || text(enrichment.profilePhotoUrl) || "";
    };
    const remember = (auditId: string, lead: Row | undefined) => {
      if (!lead) return;
      leadNameByAuditId.set(auditId, text(lead.name));
      const photo = photoOf(lead);
      if (photo) leadPhotoByAuditId.set(auditId, photo);
    };
    for (const conv of convRows) remember(text(conv.id), leadById.get(text(conv.lead_id)));
    for (const auditId of auditIds) {
      if (!conversationIds.has(auditId)) remember(auditId, leadById.get(auditId));
    }

    const events = rows.map((row) => {
      const details = object(row.details);
      const wsName = text(details.workspaceName);
      const wsId = text(details.workspaceId) || text(row.workspace_id);
      const auditId = text(row.actor_id);
      // Lead name: prefer details.leadName (set by frontend), fall back to DB lookup
      const leadName = text(details.leadName) || leadNameByAuditId.get(auditId) || "";
      return {
        id: row.id,
        timestamp: row.created_at,
        action: row.event_type,
        status: details.status ?? "unknown",
        sentiment: details.sentiment ?? null,
        inputTokens: details.inputTokens ?? 0,
        outputTokens: details.outputTokens ?? 0,
        durationMs: details.durationMs ?? null,
        workspaceName: wsName || null,
        workspaceLogoUrl: wsLogoByName.get(wsName.toLowerCase()) || wsLogoById.get(wsId) || null,
        leadName: leadName || null,
        leadPhotoUrl: leadPhotoByAuditId.get(auditId) || null,
        // Draft feed fields: the reply text the model produced and the client-voice examples
        // that were fed in. Only populated for `conversation.analyzed` and `draft.generated`.
        conversationId: auditId,
        draft: text(details.draft) || null,
        reason: text(details.reason) || null,
        inboundMessage: text(details.inboundMessage) || null,
        campaignName: text(details.campaignName) || null,
        leadTitle: text(details.leadTitle) || null,
        leadCompany: text(details.leadCompany) || null,
        // Rich past-reply context (each carries sender/lead/campaign). Falls back
        // to the legacy string array for rows written before the richer shape shipped.
        pastReplyContext: Array.isArray(details.pastReplyContext)
          ? (details.pastReplyContext as unknown[]).map((entry) => {
              const raw = object(entry);
              return {
                body: text(raw.body),
                senderName: text(raw.senderName),
                leadName: text(raw.leadName),
                campaignName: text(raw.campaignName),
              };
            }).filter((entry) => entry.body)
          : Array.isArray(details.pastReplies)
            ? (details.pastReplies as unknown[]).map((r) => ({ body: text(r), senderName: "", leadName: "", campaignName: "" })).filter((entry) => entry.body)
            : [],
      };
    });

    // Split the enriched rows back into two views. `events` is the general log
    // (limited to the original 200-row window), `drafts` is the dedicated feed
    // that survives even when hundreds of sentiment rows would otherwise push
    // draft events off the tail of the general query.
    const generalEvents = events.filter((e) => generalIds.has(text(e.id)));
    const draftEvents = events.filter((e) => draftIds.has(text(e.id)));

    const totalCalls = generalEvents.length;
    const successful = generalEvents.filter((e) => e.status === "success").length;
    const failed = generalEvents.filter((e) => e.status === "error" || e.status === "failed").length;
    const totalInputTokens = generalEvents.reduce((s, e) => s + Number(e.inputTokens || 0), 0);
    const totalOutputTokens = generalEvents.reduce((s, e) => s + Number(e.outputTokens || 0), 0);

    return NextResponse.json({
      ok: true,
      events: generalEvents,
      drafts: draftEvents,
      summary: { totalCalls, successful, failed, totalInputTokens, totalOutputTokens },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load AI audit" }, { status: 502 });
  }
}
