// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Every client workspace, for the Project management directory (internal — all clients, not just connected ones).
import { NextResponse } from "next/server";

function creds() { const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY; return url && key ? { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" } } : null; }

export async function GET() {
  const c = creds(); if (!c) return NextResponse.json({ ok: false, clients: [] }, { status: 503 });
  const r = await fetch(`${c.url}/rest/v1/rr_workspaces?select=id,name,slug,logo_url,accent_color,slack_internal_channel_id&slug=neq.misc&order=name.asc`, { headers: c.headers, cache: "no-store" });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  const clients = (Array.isArray(rows) ? rows : [])
    .filter((w: Record<string, unknown>) => String(w.name ?? "").trim())
    .map((w: Record<string, unknown>) => ({ id: String(w.id), name: String(w.name), slug: String(w.slug), logoUrl: (w.logo_url as string) || null, accentColor: (w.accent_color as string) || null, slackChannelId: (w.slack_internal_channel_id as string) || "" }));
  return NextResponse.json({ ok: true, clients });
}

// Set a client's internal Slack channel id (for the per-task "send update to Slack" button).
export async function PATCH(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || "").trim();
  if (!slug) return NextResponse.json({ ok: false, error: "slug required" }, { status: 400 });
  const channel = String(b.slackChannelId ?? "").trim().slice(0, 40);
  const r = await fetch(`${c.url}/rest/v1/rr_workspaces?slug=eq.${encodeURIComponent(slug)}`, { method: "PATCH", headers: { ...c.headers, Prefer: "return=minimal" }, body: JSON.stringify({ slack_internal_channel_id: channel || null }) });
  if (!r.ok) return NextResponse.json({ ok: false, error: `Save failed (${r.status}).` }, { status: 502 });
  return NextResponse.json({ ok: true });
}
