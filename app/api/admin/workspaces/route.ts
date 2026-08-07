import { NextResponse } from "next/server";

function supabaseConfig() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

export async function GET() {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const response = await fetch(`${url}/rest/v1/workspaces?select=id,name,slug,client_brief,anthropic_model,last_webhook_received_at,last_successful_poll_at&order=created_at.asc`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  return NextResponse.json({ ok: response.ok, workspaces: await response.json() }, { status: response.ok ? 200 : response.status });
}

export async function POST(request: Request) {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json();
  const response = await fetch(`${url}/rest/v1/workspaces`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ name: payload.name, slug: payload.slug, client_brief: payload.clientBrief ?? null, anthropic_model: payload.anthropicModel ?? null }) });
  return NextResponse.json({ ok: response.ok, workspaces: await response.json() }, { status: response.ok ? 201 : response.status });
}
