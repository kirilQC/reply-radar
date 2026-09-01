// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Persisted custom "weeks" for group project boards (e.g. "Sept 3", "Sept 10") — a small editable list
// of call dates, stored in rr_app_config so an empty week survives a reload before any task is added to it.
import { NextResponse } from "next/server";
const KEY = "project_weeks";
function creds() { const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY; return url && key ? { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" } } : null; }
async function read(c: NonNullable<ReturnType<typeof creds>>): Promise<string[]> {
  const r = await fetch(`${c.url}/rest/v1/rr_app_config?select=value&key=eq.${KEY}&limit=1`, { headers: c.headers, cache: "no-store" });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  const v = Array.isArray(rows) && rows[0] ? (rows[0].value as Record<string, unknown>) : {};
  return Array.isArray(v.weeks) ? (v.weeks as unknown[]).map(String).filter(Boolean) : [];
}
async function write(c: NonNullable<ReturnType<typeof creds>>, weeks: string[]) {
  await fetch(`${c.url}/rest/v1/rr_app_config`, { method: "POST", headers: { ...c.headers, Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key: KEY, value: { weeks }, updated_at: new Date().toISOString() }) });
}
export async function GET() { const c = creds(); if (!c) return NextResponse.json({ weeks: [] }); return NextResponse.json({ weeks: await read(c) }); }
export async function POST(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const label = String(b.week ?? "").trim().slice(0, 60);
  if (!label) return NextResponse.json({ ok: false, error: "Week label required" }, { status: 400 });
  const weeks = await read(c);
  if (!weeks.some((w) => w.toLowerCase() === label.toLowerCase())) { weeks.push(label); await write(c, weeks); }
  return NextResponse.json({ ok: true, weeks });
}
export async function DELETE(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false }, { status: 503 });
  const label = new URL(request.url).searchParams.get("week") || "";
  const weeks = (await read(c)).filter((w) => w !== label); await write(c, weeks);
  return NextResponse.json({ ok: true, weeks });
}
