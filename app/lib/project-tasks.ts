// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Shared read/write for a client's Project management board (rr_projects). Used by both the web API and
// the QC Bot assistant tools, so the bot can do everything the board UI can.

export const PROJECT_STAGES = ["todo", "in_progress", "paused", "completed", "launched"] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];
export const STAGE_LABEL: Record<string, string> = { todo: "To do", in_progress: "In progress", paused: "Paused", completed: "Completed", launched: "Launched" };
export const normalizeStage = (s: unknown): ProjectStage | null => {
  const v = String(s ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if ((PROJECT_STAGES as readonly string[]).includes(v)) return v as ProjectStage;
  const alias: Record<string, ProjectStage> = { "todo": "todo", "backlog": "todo", "not_started": "todo", "in_progress": "in_progress", "started": "in_progress", "wip": "in_progress", "paused": "paused", "on_hold": "paused", "blocked": "paused", "done": "completed", "complete": "completed", "completed": "completed", "launched": "launched", "live": "launched", "shipped": "launched" };
  return alias[v] ?? null;
};

type Row = Record<string, unknown>;
function creds() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" } } : null;
}
async function workspaceIdForSlug(slug: string, c: NonNullable<ReturnType<typeof creds>>): Promise<string> {
  if (/^[0-9a-f]{8}-/.test(slug)) return slug;
  const r = await fetch(`${c.url}/rest/v1/rr_workspaces?select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`, { headers: c.headers, cache: "no-store" });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  return Array.isArray(rows) && rows[0]?.id ? String(rows[0].id) : "";
}
export type Project = { id: string; title: string; stage: string; assignee: string | null; dueDate: string | null; context: string | null; links: string[]; source: string; createdAt: string; updatedAt: string };
const shape = (r: Row): Project => ({ id: String(r.id), title: String(r.title ?? ""), stage: String(r.stage ?? "todo"), assignee: (r.owner as string) || null, dueDate: (r.due_date as string) || null, context: (r.context as string) || null, links: Array.isArray(r.links) ? (r.links as string[]) : [], source: String(r.source ?? "manual"), createdAt: String(r.created_at ?? ""), updatedAt: String(r.updated_at ?? "") });

export async function listProjectsFor(slug: string): Promise<{ ok: boolean; error?: string; projects?: Project[] }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const wsId = await workspaceIdForSlug(slug, c); if (!wsId) return { ok: false, error: `No client matches "${slug}".` };
  const r = await fetch(`${c.url}/rest/v1/rr_projects?select=*&workspace_id=eq.${encodeURIComponent(wsId)}&order=position.asc,created_at.asc`, { headers: c.headers, cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.status === 404 ? "The rr_projects table does not exist yet." : `Load failed (${r.status}).` };
  const rows = await r.json().catch(() => []);
  return { ok: true, projects: (Array.isArray(rows) ? rows : []).map(shape) };
}
export async function createProjectFor(slug: string, input: { title: string; stage?: string; assignee?: string; dueDate?: string; context?: string; links?: string[]; source?: string }): Promise<{ ok: boolean; error?: string; project?: Project }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const wsId = await workspaceIdForSlug(slug, c); if (!wsId) return { ok: false, error: `No client matches "${slug}".` };
  const title = String(input.title ?? "").trim(); if (!title) return { ok: false, error: "A title is required." };
  const rec: Row = { workspace_id: wsId, title: title.slice(0, 300), stage: normalizeStage(input.stage) ?? "todo", owner: input.assignee ? String(input.assignee).slice(0, 80) : null, due_date: input.dueDate || null, context: input.context ? String(input.context).slice(0, 5000) : null, links: Array.isArray(input.links) ? input.links.slice(0, 30) : [], source: input.source || "manual", position: Date.now() };
  const r = await fetch(`${c.url}/rest/v1/rr_projects`, { method: "POST", headers: { ...c.headers, Prefer: "return=representation" }, body: JSON.stringify(rec) });
  if (!r.ok) return { ok: false, error: `Could not create (${r.status}).` };
  const [row] = await r.json().catch(() => []);
  return { ok: true, project: row ? shape(row) : undefined };
}
export async function updateProject(id: string, fields: { title?: string; stage?: string; assignee?: string | null; dueDate?: string | null; context?: string | null; links?: string[] }): Promise<{ ok: boolean; error?: string }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const patch: Row = { updated_at: new Date().toISOString() };
  if (typeof fields.title === "string") patch.title = fields.title.slice(0, 300);
  if (fields.stage !== undefined) { const s = normalizeStage(fields.stage); if (!s) return { ok: false, error: `Unknown stage. Use one of: ${PROJECT_STAGES.join(", ")}.` }; patch.stage = s; }
  if (fields.assignee !== undefined) patch.owner = fields.assignee ? String(fields.assignee).slice(0, 80) : null;
  if (fields.dueDate !== undefined) patch.due_date = fields.dueDate || null;
  if (fields.context !== undefined) patch.context = fields.context ? String(fields.context).slice(0, 5000) : null;
  if (fields.links !== undefined) patch.links = Array.isArray(fields.links) ? fields.links.slice(0, 30) : [];
  const r = await fetch(`${c.url}/rest/v1/rr_projects?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...c.headers, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  return r.ok ? { ok: true } : { ok: false, error: `Update failed (${r.status}).` };
}
export async function deleteProject(id: string): Promise<{ ok: boolean; error?: string }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const r = await fetch(`${c.url}/rest/v1/rr_projects?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: c.headers });
  return r.ok ? { ok: true } : { ok: false, error: `Delete failed (${r.status}).` };
}
