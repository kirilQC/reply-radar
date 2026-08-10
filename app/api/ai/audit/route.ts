import { NextResponse } from "next/server";

type Row = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : "");

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Number(params.get("limit") || 200), 500);

  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  try {
    // Purge events older than 48 hours
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
      console.error(`[ai-audit] Supabase query failed: ${response.status} ${body}`);
      throw new Error(`Supabase ${response.status}: ${body.slice(0, 200)}`);
    }
    const rows = (await response.json()) as Row[];
    const workspaces = wsResponse.ok ? ((await wsResponse.json()) as Row[]) : [];
    const wsLogoByName = new Map(workspaces.map((ws) => [text(ws.name).toLowerCase(), text(ws.logo_url)]));
    const wsLogoById = new Map(workspaces.map((ws) => [text(ws.id), text(ws.logo_url)]));

    // Collect conversation IDs to resolve lead photos
    const conversationIds = [...new Set(rows.map((row) => text((row.details as Row)?.workspaceId ? row.actor_id : row.actor_id)).filter(Boolean))];
    // actor_id = entityId = conversationId for these events
    let leadPhotoByConvId = new Map<string, string>();
    if (conversationIds.length) {
      const convResponse = await fetch(
        `${url}/rest/v1/rr_conversations?select=id,lead_id&id=in.(${conversationIds.slice(0, 100).join(",")})`,
        { headers, cache: "no-store" },
      ).catch(() => null);
      if (convResponse?.ok) {
        const convRows = (await convResponse.json()) as Row[];
        const leadIds = [...new Set(convRows.map((c) => text(c.lead_id)).filter(Boolean))];
        if (leadIds.length) {
          const leadResponse = await fetch(
            `${url}/rest/v1/rr_leads?select=id,photo_url,first_name,last_name&id=in.(${leadIds.slice(0, 100).join(",")})`,
            { headers, cache: "no-store" },
          ).catch(() => null);
          if (leadResponse?.ok) {
            const leadRows = (await leadResponse.json()) as Row[];
            const leadPhotoById = new Map(leadRows.map((l) => [text(l.id), text(l.photo_url)]));
            const leadNameById = new Map(leadRows.map((l) => [text(l.id), [text(l.first_name), text(l.last_name)].filter(Boolean).join(" ")]));
            for (const conv of convRows) {
              const lid = text(conv.lead_id);
              leadPhotoByConvId.set(text(conv.id), leadPhotoById.get(lid) || "");
              // Also store lead name fallback
              if (!leadNameById.get(lid)) continue;
            }
            // Build a name fallback map too
            const leadNameByConvId = new Map(convRows.map((c) => [text(c.id), leadNameById.get(text(c.lead_id)) || ""]));
            // We'll use this below
            leadPhotoByConvId = new Map(convRows.map((c) => [text(c.id), leadPhotoById.get(text(c.lead_id)) || ""]));
            // Enrich events with lead names where details.leadName is missing
            for (const row of rows) {
              const details = row.details && typeof row.details === "object" ? row.details as Row : {};
              if (!details.leadName) {
                const convId = text(row.actor_id);
                const name = leadNameByConvId.get(convId);
                if (name) details.leadName = name;
              }
            }
          }
        }
      }
    }

    const events = rows.map((row) => {
      const details = row.details && typeof row.details === "object" ? row.details as Row : {};
      const wsName = text(details.workspaceName);
      const wsId = text(details.workspaceId) || text(row.workspace_id);
      const convId = text(row.actor_id);
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
        leadName: details.leadName ?? null,
        leadPhotoUrl: leadPhotoByConvId.get(convId) || null,
      };
    });

    // Compute summary stats
    const totalCalls = events.length;
    const successful = events.filter((event) => event.status === "success").length;
    const failed = events.filter((event) => event.status === "error" || event.status === "failed").length;
    const totalInputTokens = events.reduce((sum, event) => sum + Number(event.inputTokens || 0), 0);
    const totalOutputTokens = events.reduce((sum, event) => sum + Number(event.outputTokens || 0), 0);

    return NextResponse.json({
      ok: true,
      events,
      summary: { totalCalls, successful, failed, totalInputTokens, totalOutputTokens },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load AI audit" }, { status: 502 });
  }
}
