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
export type ProjectLink = string | { url: string; title?: string };
export type Project = { id: string; title: string; stage: string; assignee: string | null; priority: string | null; week: string | null; dueDate: string | null; context: string | null; links: ProjectLink[]; blockers: unknown[]; source: string; createdAt: string; updatedAt: string };
const PRIORITIES = ["high", "medium", "low"];
export const normalizePriority = (p: unknown): string | null => { const v = String(p ?? "").toLowerCase().trim(); if (!v || v === "none") return null; if (PRIORITIES.includes(v)) return v; const alias: Record<string, string> = { urgent: "high", h: "high", hi: "high", med: "medium", m: "medium", normal: "medium", l: "low", lo: "low" }; return alias[v] ?? null; };
const normLinks = (links?: ProjectLink[]): ProjectLink[] => (Array.isArray(links) ? links.map((l) => (typeof l === "string" ? l : l && l.url ? { url: String(l.url), ...(l.title ? { title: String(l.title) } : {}) } : null)).filter(Boolean).slice(0, 30) as ProjectLink[] : []);
const shape = (r: Row): Project => ({ id: String(r.id), title: String(r.title ?? ""), stage: String(r.stage ?? "todo"), assignee: (r.owner as string) || null, priority: (r.priority as string) || null, week: (r.week as string) || null, dueDate: (r.due_date as string) || null, context: (r.context as string) || null, links: Array.isArray(r.links) ? (r.links as ProjectLink[]) : [], blockers: Array.isArray(r.blocker) ? (r.blocker as unknown[]) : r.blocker ? [r.blocker] : [], source: String(r.source ?? "manual"), createdAt: String(r.created_at ?? ""), updatedAt: String(r.updated_at ?? "") });

export async function listProjectsFor(slug: string, opts?: { week?: string }): Promise<{ ok: boolean; error?: string; projects?: Project[] }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const wsId = await workspaceIdForSlug(slug, c); if (!wsId) return { ok: false, error: `No client matches "${slug}".` };
  const r = await fetch(`${c.url}/rest/v1/rr_projects?select=*&workspace_id=eq.${encodeURIComponent(wsId)}&order=position.asc,created_at.asc`, { headers: c.headers, cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.status === 404 ? "The rr_projects table does not exist yet." : `Load failed (${r.status}).` };
  const rows = await r.json().catch(() => []);
  let projects = (Array.isArray(rows) ? rows : []).map(shape);
  if (opts?.week) { const w = opts.week.toLowerCase(); projects = projects.filter((p) => (p.week ?? "").toLowerCase() === w); }
  return { ok: true, projects };
}
export async function createProjectFor(slug: string, input: { title: string; stage?: string; assignee?: string; priority?: string; week?: string; dueDate?: string; context?: string; links?: ProjectLink[]; source?: string }): Promise<{ ok: boolean; error?: string; project?: Project }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const wsId = await workspaceIdForSlug(slug, c); if (!wsId) return { ok: false, error: `No client matches "${slug}".` };
  const title = String(input.title ?? "").trim(); if (!title) return { ok: false, error: "A title is required." };
  const rec: Row = { workspace_id: wsId, title: title.slice(0, 300), stage: normalizeStage(input.stage) ?? "todo", owner: input.assignee ? String(input.assignee).slice(0, 400) : null, priority: normalizePriority(input.priority), week: input.week ? String(input.week).slice(0, 60) : null, due_date: input.dueDate || null, context: input.context ? String(input.context).slice(0, 5000) : null, links: normLinks(input.links), source: input.source || "manual", position: Date.now() };
  const r = await fetch(`${c.url}/rest/v1/rr_projects`, { method: "POST", headers: { ...c.headers, Prefer: "return=representation" }, body: JSON.stringify(rec) });
  if (!r.ok) return { ok: false, error: `Could not create (${r.status}).` };
  const [row] = await r.json().catch(() => []);
  return { ok: true, project: row ? shape(row) : undefined };
}
export async function updateProject(id: string, fields: { title?: string; stage?: string; assignee?: string | null; priority?: string | null; week?: string | null; dueDate?: string | null; context?: string | null; links?: ProjectLink[]; reassignSlug?: string }): Promise<{ ok: boolean; error?: string }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const patch: Row = { updated_at: new Date().toISOString() };
  if (typeof fields.title === "string") patch.title = fields.title.slice(0, 300);
  if (fields.stage !== undefined) { const s = normalizeStage(fields.stage); if (!s) return { ok: false, error: `Unknown stage. Use one of: ${PROJECT_STAGES.join(", ")}.` }; patch.stage = s; }
  if (fields.assignee !== undefined) patch.owner = fields.assignee ? String(fields.assignee).slice(0, 400) : null;
  if (fields.priority !== undefined) patch.priority = normalizePriority(fields.priority);
  if (fields.week !== undefined) patch.week = fields.week ? String(fields.week).slice(0, 60) : null;
  if (fields.dueDate !== undefined) patch.due_date = fields.dueDate || null;
  if (fields.context !== undefined) patch.context = fields.context ? String(fields.context).slice(0, 5000) : null;
  if (fields.links !== undefined) patch.links = normLinks(fields.links);
  if (fields.reassignSlug) { const wsId = await workspaceIdForSlug(fields.reassignSlug, c); if (!wsId) return { ok: false, error: `No client matches "${fields.reassignSlug}".` }; patch.workspace_id = wsId; }
  const r = await fetch(`${c.url}/rest/v1/rr_projects?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...c.headers, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  return r.ok ? { ok: true } : { ok: false, error: `Update failed (${r.status}).` };
}
export async function deleteProject(id: string): Promise<{ ok: boolean; error?: string }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const r = await fetch(`${c.url}/rest/v1/rr_projects?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: c.headers });
  return r.ok ? { ok: true } : { ok: false, error: `Delete failed (${r.status}).` };
}
