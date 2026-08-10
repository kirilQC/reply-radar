import { NextResponse } from "next/server";

type Row = Record<string, unknown>;

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

    // Query audit log — filter by actor_type column
    const response = await fetch(
      `${url}/rest/v1/rr_audit_log?select=*&actor_type=eq.anthropic&order=created_at.desc&limit=${limit}`,
      { headers, cache: "no-store" },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[ai-audit] Supabase query failed: ${response.status} ${body}`);
      throw new Error(`Supabase ${response.status}: ${body.slice(0, 200)}`);
    }
    const rows = (await response.json()) as Row[];

    const events = rows.map((row) => {
      const details = row.details && typeof row.details === "object" ? row.details as Row : {};
      return {
        id: row.id,
        timestamp: row.created_at,
        action: row.event_type,
        status: details.status ?? "unknown",
        model: details.model ?? null,
        sentiment: details.sentiment ?? null,
        inputTokens: details.inputTokens ?? 0,
        outputTokens: details.outputTokens ?? 0,
        durationMs: details.durationMs ?? null,
        workspaceName: details.workspaceName ?? null,
        leadName: details.leadName ?? null,
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
