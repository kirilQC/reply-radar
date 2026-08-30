import { NextResponse } from "next/server";
export const maxDuration = 30;
export async function GET() {
  const url = process.env.SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const h = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const existing = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,logo_url&slug=eq.misc&limit=1`, { headers: h, cache: "no-store" });
  const rows = await existing.json().catch(() => []);
  if (Array.isArray(rows) && rows.length) return NextResponse.json({ existed: true, workspace: rows[0] });
  const create = await fetch(`${url}/rest/v1/rr_workspaces`, { method: "POST", headers: { ...h, Prefer: "return=representation" },
    body: JSON.stringify({ name: "Misc", slug: "misc", logo_url: "/qc-growth-logo.png", accent_color: "#8b7cff" }) });
  const created = await create.text();
  return NextResponse.json({ created: create.ok, status: create.status, body: created.slice(0, 500) });
}
