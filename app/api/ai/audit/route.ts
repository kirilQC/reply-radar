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
    // Purge events older than 48 hours (fire-and-forget)
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    void fetch(
      `${url}/rest/v1/rr_audit_log?actor_type=eq.anthropic&created_at=lt.${cutoff}`,
      { method: "DELETE", headers: { ...headers, Prefer: "return=minimal" } },
    ).catch(() => null);

    // Fetch audit rows + workspace logos in parallel
    const [response, wsResponse] = await Promise.all([
      fetch(`${url}/rest/v1/rr_audit_log?select=*&actor_type=eq.anthropic&order=created_at.desc&limit=${limit}`, { headers, cache: "no-store" }),
      fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,logo_url`, { headers, cache: "no-store" }),
    ]);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Supabase ${response.status}: ${body.slice(0, 200)}`);
    }
    const rows = (await response.json()) as Row[];
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
        pastReplies: Array.isArray(details.pastReplies) ? (details.pastReplies as unknown[]).map((r) => text(r)).filter(Boolean) : [],
      };
    });

    const totalCalls = events.length;
    const successful = events.filter((e) => e.status === "success").length;
    const failed = events.filter((e) => e.status === "error" || e.status === "failed").length;
    const totalInputTokens = events.reduce((s, e) => s + Number(e.inputTokens || 0), 0);
    const totalOutputTokens = events.reduce((s, e) => s + Number(e.outputTokens || 0), 0);

    return NextResponse.json({
      ok: true,
      events,
      summary: { totalCalls, successful, failed, totalInputTokens, totalOutputTokens },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load AI audit" }, { status: 502 });
  }
}
