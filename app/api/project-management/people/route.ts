// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The assignee roster for Project management.
 *
 * Each client board and each view has its own roster (`?scope=client:<slug>` or `view:<slug>`), so the
 * Healthtech team doesn't show up as assignees on Camb's board. The old single roster (no scope) is kept
 * as `legacy`: boards use it only to show the photo or mascot of someone already assigned to a task.
 * Every new teammate gets a mascot straight away, the one least used on that roster.
 */
import { NextResponse } from "next/server";

const BASE_KEY = "project_people";
const MASCOT_IDS = ["fox", "owl", "cat", "bear", "frog", "panda", "penguin", "bunny", "octopus", "axolotl"];
type Person = { name: string; avatarUrl: string | null };

function creds() { const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY; return url && key ? { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" } } : null; }
const keyFor = (scope: string) => (scope ? `${BASE_KEY}:${scope}` : BASE_KEY);
const scopeOf = (request: Request, body?: Record<string, unknown>) => String((body?.scope as string) ?? new URL(request.url).searchParams.get("scope") ?? "").trim().slice(0, 120).replace(/[^\w:.-]/g, "");

async function read(c: NonNullable<ReturnType<typeof creds>>, key: string): Promise<Person[]> {
  const r = await fetch(`${c.url}/rest/v1/rr_app_config?select=value&key=eq.${encodeURIComponent(key)}&limit=1`, { headers: c.headers, cache: "no-store" });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  const v = Array.isArray(rows) && rows[0] ? (rows[0].value as Record<string, unknown>) : {};
  const arr = Array.isArray(v.people) ? (v.people as unknown[]) : [];
  return arr.map((p) => (typeof p === "string" ? { name: p, avatarUrl: null } : { name: String((p as Person).name ?? ""), avatarUrl: (p as Person).avatarUrl ?? null })).filter((p) => p.name);
}
async function write(c: NonNullable<ReturnType<typeof creds>>, key: string, people: Person[]) {
  await fetch(`${c.url}/rest/v1/rr_app_config`, { method: "POST", headers: { ...c.headers, Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key, value: { people }, updated_at: new Date().toISOString() }) });
}
/** The mascot used least on this roster, so a new teammate rarely looks like an existing one. */
function nextMascot(people: Person[]): string {
  const used = new Map(MASCOT_IDS.map((id) => [id, 0]));
  for (const p of people) { const id = String(p.avatarUrl ?? "").replace(/^mascot:/, ""); if (used.has(id)) used.set(id, (used.get(id) ?? 0) + 1); }
  const least = Math.min(...used.values());
  const options = MASCOT_IDS.filter((id) => used.get(id) === least);
  return `mascot:${options[Math.floor(Math.random() * options.length)]}`;
}

export async function GET(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ people: [], legacy: [] });
  const scope = scopeOf(request);
  const [people, legacy] = await Promise.all([read(c, keyFor(scope)), scope ? read(c, BASE_KEY) : Promise.resolve([] as Person[])]);
  return NextResponse.json({ people, legacy });
}

export async function POST(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const scope = scopeOf(request, b);
  const key = keyFor(scope);
  const name = String(b.name ?? "").trim().slice(0, 80);
  if (!name) return NextResponse.json({ ok: false, error: "Name required" }, { status: 400 });
  const avatarUrl = b.avatarUrl ? String(b.avatarUrl).slice(0, 600) : undefined;
  const people = await read(c, key);
  const existing = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) { if (avatarUrl !== undefined) existing.avatarUrl = avatarUrl || null; }
  else {
    // A name already on this board's tasks keeps its spelling and look; anyone new is one word of up to
    // 10 characters, so names fit on cards and in mentions.
    const keep = b.keepName === true;
    const short = keep ? name : name.replace(/\s+/g, "").slice(0, 10);
    if (!short) return NextResponse.json({ ok: false, error: "Name required" }, { status: 400 });
    if (!people.some((p) => p.name.toLowerCase() === short.toLowerCase())) people.push({ name: short, avatarUrl: avatarUrl ?? nextMascot(people) });
  }
  people.sort((a, z) => a.name.localeCompare(z.name));
  await write(c, key, people);
  return NextResponse.json({ ok: true, people });
}

export async function DELETE(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false }, { status: 503 });
  const key = keyFor(scopeOf(request));
  const name = new URL(request.url).searchParams.get("name") || "";
  const people = (await read(c, key)).filter((p) => p.name !== name); await write(c, key, people);
  return NextResponse.json({ ok: true, people });
}
