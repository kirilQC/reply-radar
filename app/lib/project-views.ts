// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Custom Project-management views: named groups that combine several clients into one board (e.g. "Healthtech").
// Stored as one row in rr_app_config — a small internal list, not worth its own table. Projects still belong
// to their real client; a view is only a lens over several clients at once.

const KEY = "project_views";
type Row = Record<string, unknown>;
export type ProjectView = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; slackChannelId: string; memberSlugs: string[] };

function creds() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" } } : null;
}
const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || `view-${Date.now().toString(36)}`;
const shape = (v: Row): ProjectView => ({ id: String(v.id ?? ""), name: String(v.name ?? ""), slug: String(v.slug ?? ""), logoUrl: (v.logoUrl as string) || null, accentColor: (v.accentColor as string) || null, slackChannelId: (v.slackChannelId as string) || "", memberSlugs: Array.isArray(v.memberSlugs) ? (v.memberSlugs as unknown[]).map(String) : [] });

export async function listViews(): Promise<ProjectView[]> {
  const c = creds(); if (!c) return [];
  const r = await fetch(`${c.url}/rest/v1/rr_app_config?select=value&key=eq.${KEY}&limit=1`, { headers: c.headers, cache: "no-store" });
  if (!r.ok) return [];
  const rows = await r.json().catch(() => []);
  const value = Array.isArray(rows) && rows[0] ? (rows[0].value as Row) : {};
  return Array.isArray(value.views) ? (value.views as Row[]).map(shape) : [];
}
async function save(views: ProjectView[], c: NonNullable<ReturnType<typeof creds>>): Promise<boolean> {
  const r = await fetch(`${c.url}/rest/v1/rr_app_config`, { method: "POST", headers: { ...c.headers, Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key: KEY, value: { views }, updated_at: new Date().toISOString() }) });
  return r.ok;
}
export async function getView(slug: string): Promise<ProjectView | null> {
  return (await listViews()).find((v) => v.slug === slug) ?? null;
}
export async function createView(input: { name: string; memberSlugs: string[]; logoUrl?: string | null; accentColor?: string | null; slackChannelId?: string }): Promise<{ ok: boolean; error?: string; view?: ProjectView }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const name = String(input.name ?? "").trim(); if (!name) return { ok: false, error: "A view needs a name." };
  const members = Array.from(new Set((input.memberSlugs ?? []).map(String).filter(Boolean)));
  if (!members.length) return { ok: false, error: "Pick at least one client for the view." };
  const views = await listViews();
  let slug = slugify(name); let n = 2; while (views.some((v) => v.slug === slug)) slug = `${slugify(name)}-${n++}`;
  const view: ProjectView = { id: `pv_${Date.now().toString(36)}`, name: name.slice(0, 80), slug, logoUrl: input.logoUrl || null, accentColor: input.accentColor || null, slackChannelId: (input.slackChannelId || "").trim().slice(0, 40), memberSlugs: members };
  if (!(await save([...views, view], c))) return { ok: false, error: "Could not save the view." };
  return { ok: true, view };
}
export async function updateView(id: string, fields: Partial<{ name: string; memberSlugs: string[]; logoUrl: string | null; accentColor: string | null; slackChannelId: string }>): Promise<{ ok: boolean; error?: string }> {
  const c = creds(); if (!c) return { ok: false, error: "Supabase not configured" };
  const views = await listViews();
  const idx = views.findIndex((v) => v.id === id); if (idx < 0) return { ok: false, error: "View not found." };
  const cur = views[idx];
  views[idx] = { ...cur, name: fields.name !== undefined ? String(fields.name).slice(0, 80) : cur.name, memberSlugs: fields.memberSlugs !== undefined ? Array.from(new Set(fields.memberSlugs.map(String).filter(Boolean))) : cur.memberSlugs, logoUrl: fields.logoUrl !== undefined ? fields.logoUrl : cur.logoUrl, accentColor: fields.accentColor !== undefined ? fields.accentColor : cur.accentColor, slackChannelId: fields.slackChannelId !== undefined ? String(fields.slackChannelId).trim().slice(0, 40) : cur.slackChannelId };
  return (await save(views, c)) ? { ok: true } : { ok: false, error: "Could not save." };
}
export async function deleteView(id: string): Promise<{ ok: boolean }> {
  const c = creds(); if (!c) return { ok: false };
  const views = (await listViews()).filter((v) => v.id !== id);
  return { ok: await save(views, c) };
}
