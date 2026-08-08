import { NextResponse } from "next/server";

function supabaseConfig() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

export async function GET() {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const response = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,client_brief,anthropic_model,logo_url,accent_color,last_webhook_received_at,last_successful_poll_at,created_at,heyreach_api_key_ciphertext&order=created_at.asc`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  const rows = await response.json();
  const workspaces = Array.isArray(rows) ? rows.map((row) => ({ ...row, key_configured: Boolean(row.heyreach_api_key_ciphertext), heyreach_api_key_ciphertext: undefined })) : rows;
  return NextResponse.json({ ok: response.ok, workspaces }, { status: response.ok ? 200 : response.status });
}

export async function POST(request: Request) {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json();
  const record: Record<string, unknown> = { name: payload.name ?? "", slug: payload.slug, client_brief: payload.clientBrief ?? null, anthropic_model: payload.anthropicModel ?? null, logo_url: payload.logoUrl ?? null, accent_color: payload.accentColor ?? null };
  if (typeof payload.heyreachApiKey === "string" && payload.heyreachApiKey.trim()) record.heyreach_api_key_ciphertext = payload.heyreachApiKey.trim();
  const response = await fetch(`${url}/rest/v1/rr_workspaces?on_conflict=slug`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(record) });
  const body = await response.text();
  let data: unknown = null; try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  return NextResponse.json({ ok: response.ok, workspaces: data }, { status: response.ok ? 201 : response.status });
}
