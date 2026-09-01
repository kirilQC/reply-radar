// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Keeps a client's internal Project management board (rr_projects) live off the same signals the morning
 * brief and call analysis already read — Slack channels, the last client call, HeyReach figures.
 *
 * The board must not become a never-ending to-do list. So this is a reconciliation, not an append:
 *
 *  - It reuses the SAME extraction the tracker uses (`extractTrackerItems`), which reads the brief/recap
 *    that was just posted and returns a stable `key` per item — reusing a key already on the board when
 *    the same work is raised again, however differently it is worded. That is what stops a second copy.
 *  - An auto item already on the board is UPDATED in place (status, owner, priority, detail), never
 *    duplicated. Matching is by `tracker_key`.
 *  - An auto item that has fallen off the outstanding list — the brief no longer raises it — is taken as
 *    completed, but only after a grace period (a single quiet morning is not proof it is done), mirroring
 *    the Airtable tracker's staleness rule.
 *  - Hand-made tasks (no tracker_key) are NEVER touched, and an auto item a human has already closed
 *    (completed/launched) is left closed rather than resurrected.
 *
 * Like every post-send filing step, it never throws: a failure here must not turn a delivered brief into
 * a failed run. Callers get counts back and log them.
 */
import { extractTrackerItems, type TrackerItem, type OpenItem } from "./tracker-extract";
import type { BriefSignals } from "./morning-brief";

export type AutosyncSource = "morning_brief" | "call_analysis";
export type AutosyncResult = { attempted: boolean; created: number; updated: number; completed: number; error: string };

// How long an auto item may go unmentioned before it is taken as done. The brief runs a few mornings a
// week; a stale window a little over a week means one missed mention never closes live work.
const STALE_DAYS = 8;
const TERMINAL = new Set(["completed", "launched"]);
const STATUS_STAGE: Record<string, string> = { "Not Started": "todo", "In Progress": "in_progress", "Blocked": "paused" };
const PRIORITY_MAP: Record<string, string> = { Urgent: "high", High: "high", Medium: "medium", Low: "low" };

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
async function rowsFor(wsId: string, c: NonNullable<ReturnType<typeof creds>>): Promise<Row[]> {
  const r = await fetch(`${c.url}/rest/v1/rr_projects?select=*&workspace_id=eq.${encodeURIComponent(wsId)}`, { headers: c.headers, cache: "no-store" });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  return Array.isArray(rows) ? rows : [];
}

/** The auto items already on a client's board, so the extractor reuses their keys instead of inventing new ones. */
export async function openProjectItems(slug: string): Promise<OpenItem[]> {
  const c = creds(); if (!c) return [];
  const wsId = await workspaceIdFor(slug, c); if (!wsId) return [];
  return (await rowsFor(wsId, c))
    .filter((r) => String(r.tracker_key ?? "").trim() && !TERMINAL.has(String(r.stage ?? "")))
    .map((r) => ({ key: String(r.tracker_key), title: String(r.title ?? ""), owner: String(r.owner ?? "") }));
}

/** Reconcile a set of already-extracted items into rr_projects. Create new, update open, close the gone. */
export async function syncProjectsFromItems(slug: string, items: TrackerItem[], source: AutosyncSource): Promise<AutosyncResult> {
  const out: AutosyncResult = { attempted: true, created: 0, updated: 0, completed: 0, error: "" };
  const c = creds(); if (!c) return { ...out, attempted: false, error: "Supabase not configured" };
  const wsId = await workspaceIdFor(slug, c); if (!wsId) return { ...out, attempted: false, error: `No client matches "${slug}".` };
  const now = new Date().toISOString();
  const rows = await rowsFor(wsId, c);
  const auto = rows.filter((r) => String(r.tracker_key ?? "").trim());
  const byKey = new Map(auto.map((r) => [String(r.tracker_key), r]));
  const seen = new Set<string>();

  for (const it of items) {
    if (!it.key) continue;
    seen.add(it.key);
    const stage = STATUS_STAGE[it.status] ?? "todo";
    const priority = PRIORITY_MAP[it.priority] ?? "medium";
    const owner = it.owner || null;
    const context = it.detail || null;
    const existing = byKey.get(it.key);
    if (existing) {
      // A human (or a prior run) has already closed it — leave it closed, don't reopen.
      if (TERMINAL.has(String(existing.stage ?? ""))) continue;
      const patch: Row = { title: it.title.slice(0, 300), stage, priority, owner, context, source, autosync_seen: now, updated_at: now };
      await fetch(`${c.url}/rest/v1/rr_projects?id=eq.${encodeURIComponent(String(existing.id))}`, { method: "PATCH", headers: { ...c.headers, Prefer: "return=minimal" }, body: JSON.stringify(patch) }).catch(() => {});
      out.updated++;
    } else {
      const rec: Row = { workspace_id: wsId, title: it.title.slice(0, 300), stage, priority, owner, context, links: [], source, tracker_key: it.key, autosync_seen: now, week: null, position: Date.now() };
      await fetch(`${c.url}/rest/v1/rr_projects`, { method: "POST", headers: { ...c.headers, Prefer: "return=minimal" }, body: JSON.stringify(rec) }).catch(() => {});
      out.created++;
    }
  }

  // Auto items the brief no longer raises → completed, but only once they have been quiet past the grace window.
  for (const r of auto) {
    const key = String(r.tracker_key);
    if (seen.has(key) || TERMINAL.has(String(r.stage ?? ""))) continue;
    const seenAt = r.autosync_seen ? Date.parse(String(r.autosync_seen)) : NaN;
    const ageDays = Number.isNaN(seenAt) ? Infinity : (Date.now() - seenAt) / 86_400_000;
    if (ageDays < STALE_DAYS) continue;
    await fetch(`${c.url}/rest/v1/rr_projects?id=eq.${encodeURIComponent(String(r.id))}`, { method: "PATCH", headers: { ...c.headers, Prefer: "return=minimal" }, body: JSON.stringify({ stage: "completed", autosync_seen: now, updated_at: now }) }).catch(() => {});
    out.completed++;
  }
  return out;
}

/** Extract outstanding items from a posted brief/recap and reconcile them into the client's board. */
export async function autosyncProjects(
  slug: string,
  text: string,
  opts: { campaignNames?: string[]; people?: Array<{ id: string; name: string }>; source: AutosyncSource; timeoutMs?: number },
): Promise<AutosyncResult> {
  try {
    const open = await openProjectItems(slug);
    const signals = { campaigns: { names: (opts.campaignNames ?? []).map((name) => ({ name })) } } as unknown as BriefSignals;
    const extracted = await extractTrackerItems(text, signals, { people: opts.people ?? [], open, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    if (extracted.error) return { attempted: true, created: 0, updated: 0, completed: 0, error: extracted.error };
    return await syncProjectsFromItems(slug, extracted.items, opts.source);
  } catch (e) {
    return { attempted: true, created: 0, updated: 0, completed: 0, error: e instanceof Error ? e.message : "autosync failed" };
  }
}
