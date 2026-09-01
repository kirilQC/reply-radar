// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// CRUD for a client's internal projects/tasks (the Project management board). Tasks live in rr_projects,
// keyed to a workspace, with a stage the team drags them through.
import { NextResponse } from "next/server";

const STAGES = ["todo", "in_progress", "paused", "completed", "launched"];
type Row = Record<string, unknown>;

function creds() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" } } : null;
}
async function workspaceIdFor(slug: string, c: NonNullable<ReturnType<typeof creds>>): Promise<string> {
  if (/^[0-9a-f]{8}-/.test(slug)) return slug;
  const r = await fetch(`${c.url}/rest/v1/rr_workspaces?select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`, { headers: c.headers, cache: "no-store" });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  return Array.isArray(rows) && rows[0]?.id ? String(rows[0].id) : "";
}
const TABLE_MISSING = "The rr_projects table doesn't exist yet — run the Project management SQL in Supabase, then reload.";

export async function GET(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const params = new URL(request.url).searchParams;
  // A single client (slug=) or a group of clients (slugs=a,b,c) — the group tags each task with its client.
  const slugList = (params.get("slugs") || params.get("slug") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!slugList.length) return NextResponse.json({ ok: false, error: "No client given." }, { status: 400 });
  const resolved = await Promise.all(slugList.map(async (slug) => ({ slug, id: await workspaceIdFor(slug, c) })));
  const nameRows = await fetch(`${c.url}/rest/v1/rr_workspaces?select=id,name,slug&id=in.(${resolved.filter((r) => r.id).map((r) => r.id).join(",") || "00000000-0000-0000-0000-000000000000"})`, { headers: c.headers, cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const nameById = new Map((Array.isArray(nameRows) ? nameRows : []).map((w: Record<string, unknown>) => [String(w.id), String(w.name)]));
  const ids = resolved.filter((r) => r.id);
  if (!ids.length) return NextResponse.json({ ok: false, error: "No client matches that slug." }, { status: 404 });
  const slugById = new Map(ids.map((r) => [r.id, r.slug]));
  const r = await fetch(`${c.url}/rest/v1/rr_projects?select=*&workspace_id=in.(${ids.map((r) => r.id).join(",")})&order=position.asc,created_at.asc`, { headers: c.headers, cache: "no-store" });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.status === 404 ? TABLE_MISSING : `Load failed (${r.status}).`, tasks: [] });
  const rows = await r.json().catch(() => []);
  const tasks = (Array.isArray(rows) ? rows : []).map((t: Record<string, unknown>) => ({ ...t, clientSlug: slugById.get(String(t.workspace_id)) ?? "", clientName: nameById.get(String(t.workspace_id)) ?? "" }));
  return NextResponse.json({ ok: true, tasks });
}

export async function POST(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const slug = String(b.slug || "");
  const title = String(b.title || "").trim();
  if (!title) return NextResponse.json({ ok: false, error: "A title is required." }, { status: 400 });
  const wsId = await workspaceIdFor(slug, c);
  if (!wsId) return NextResponse.json({ ok: false, error: "No client matches that slug." }, { status: 404 });
  const stage = STAGES.includes(String(b.stage)) ? String(b.stage) : "todo";
  const links = Array.isArray(b.links) ? b.links.slice(0, 30) : [];
  const rec: Row = { workspace_id: wsId, title: title.slice(0, 300), stage, owner: b.owner ? String(b.owner).slice(0, 80) : null, due_date: b.dueDate || null, context: b.context ? String(b.context).slice(0, 5000) : null, links, source: b.source ? String(b.source) : "manual", position: typeof b.position === "number" ? b.position : Date.now() };
  const r = await fetch(`${c.url}/rest/v1/rr_projects`, { method: "POST", headers: { ...c.headers, Prefer: "return=representation" }, body: JSON.stringify(rec) });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.status === 404 ? TABLE_MISSING : `Could not create (${r.status}).` }, { status: 502 });
  const [task] = await r.json().catch(() => []);
  return NextResponse.json({ ok: true, task });
}

export async function PATCH(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const id = String(b.id || "");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  const patch: Row = { updated_at: new Date().toISOString() };
  if (typeof b.title === "string") patch.title = b.title.slice(0, 300);
  if (STAGES.includes(String(b.stage))) patch.stage = b.stage;
  if ("owner" in b) patch.owner = b.owner ? String(b.owner).slice(0, 80) : null;
  if ("dueDate" in b) patch.due_date = b.dueDate || null;
  if ("context" in b) patch.context = b.context ? String(b.context).slice(0, 5000) : null;
  if ("links" in b) patch.links = Array.isArray(b.links) ? b.links.slice(0, 30) : [];
  if (typeof b.position === "number") patch.position = b.position;
  const r = await fetch(`${c.url}/rest/v1/rr_projects?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...c.headers, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  if (!r.ok) return NextResponse.json({ ok: false, error: `Update failed (${r.status}).` }, { status: 502 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  const r = await fetch(`${c.url}/rest/v1/rr_projects?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: c.headers });
  if (!r.ok) return NextResponse.json({ ok: false, error: `Delete failed (${r.status}).` }, { status: 502 });
  return NextResponse.json({ ok: true });
}
