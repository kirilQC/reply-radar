// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// The assignee roster for Project management — a small editable list of teammates (name + optional photo),
// stored in rr_app_config.
import { NextResponse } from "next/server";
const KEY = "project_people";
type Person = { name: string; avatarUrl: string | null };
function creds() { const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY; return url && key ? { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" } } : null; }
async function read(c: NonNullable<ReturnType<typeof creds>>): Promise<Person[]> {
  const r = await fetch(`${c.url}/rest/v1/rr_app_config?select=value&key=eq.${KEY}&limit=1`, { headers: c.headers, cache: "no-store" });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  const v = Array.isArray(rows) && rows[0] ? (rows[0].value as Record<string, unknown>) : {};
  const arr = Array.isArray(v.people) ? (v.people as unknown[]) : [];
  // Back-compat: older data stored plain strings.
  return arr.map((p) => (typeof p === "string" ? { name: p, avatarUrl: null } : { name: String((p as Person).name ?? ""), avatarUrl: (p as Person).avatarUrl ?? null })).filter((p) => p.name);
}
async function write(c: NonNullable<ReturnType<typeof creds>>, people: Person[]) {
  await fetch(`${c.url}/rest/v1/rr_app_config`, { method: "POST", headers: { ...c.headers, Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key: KEY, value: { people }, updated_at: new Date().toISOString() }) });
}
export async function GET() { const c = creds(); if (!c) return NextResponse.json({ people: [] }); return NextResponse.json({ people: await read(c) }); }
export async function POST(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const name = String(b.name ?? "").trim().slice(0, 80);
  if (!name) return NextResponse.json({ ok: false, error: "Name required" }, { status: 400 });
  const avatarUrl = b.avatarUrl ? String(b.avatarUrl).slice(0, 600) : undefined;
  const people = await read(c);
  const existing = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) { if (avatarUrl !== undefined) existing.avatarUrl = avatarUrl || null; }
  else people.push({ name, avatarUrl: avatarUrl ?? null });
  people.sort((a, z) => a.name.localeCompare(z.name));
  await write(c, people);
  return NextResponse.json({ ok: true, people });
}
export async function DELETE(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false }, { status: 503 });
  const name = new URL(request.url).searchParams.get("name") || "";
  const people = (await read(c)).filter((p) => p.name !== name); await write(c, people);
  return NextResponse.json({ ok: true, people });
}
