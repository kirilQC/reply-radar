import { NextResponse } from "next/server";
export const maxDuration = 30;
export async function GET() {
  const url = process.env.SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const q = async (p: string) => { const r = await fetch(`${url}/rest/v1/${p}`, { headers: h, cache: "no-store" }); return r.ok ? r.json() : { err: r.status, body: (await r.text()).slice(0,200) }; };
  const failed = await q(`rr_audit_log?select=created_at,event_type,details&actor_type=eq.anthropic&event_type=eq.draft.failed&order=created_at.desc&limit=6`);
  const ok = await q(`rr_audit_log?select=created_at,event_type,details&actor_type=eq.anthropic&event_type=eq.draft.generated&order=created_at.desc&limit=3`);
  const slim = (rows: unknown) => Array.isArray(rows) ? rows.map((r: Record<string,unknown>) => { const d = (r.details ?? {}) as Record<string,unknown>; return { at: r.created_at, model: d.model, status: d.status, summary: (d.summary as string || "").slice(0,120), inTok: d.inputTokens, ws: d.workspaceName }; }) : rows;
  return NextResponse.json({ failed: slim(failed), generated: slim(ok) });
}
