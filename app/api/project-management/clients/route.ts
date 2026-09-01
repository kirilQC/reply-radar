// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Every client workspace, for the Project management directory (internal — all clients, not just connected ones).
import { NextResponse } from "next/server";

export async function GET() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, clients: [] }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const r = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,logo_url,accent_color&slug=neq.misc&order=name.asc`, { headers, cache: "no-store" });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  const clients = (Array.isArray(rows) ? rows : [])
    .filter((w: Record<string, unknown>) => String(w.name ?? "").trim())
    .map((w: Record<string, unknown>) => ({ id: String(w.id), name: String(w.name), slug: String(w.slug), logoUrl: (w.logo_url as string) || null, accentColor: (w.accent_color as string) || null }));
  return NextResponse.json({ ok: true, clients });
}
