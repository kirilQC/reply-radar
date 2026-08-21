// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The I/O half of the onboarding hub: reading and writing the directory, the per-client checklist and the
 * editable template through Supabase's PostgREST, and posting a checkoff to the client's internal Slack
 * channel. The maths and the message text it leans on are the pure exports of `shared/onboarding.mjs`, so
 * everything decided here — which leaf a checkoff completes, whether the client just flipped to complete —
 * is the same thing the tests cover.
 *
 * A client in the hub is a full `rr_workspaces` row (the design decision: added up front, its configuration
 * filled in as the final checklist section is worked through). So "add a client" is an insert into
 * `rr_workspaces` plus a snapshot of the template into `rr_onboarding_tasks`; nothing lives in a parallel
 * "onboarding client" table.
 */

import { postMessage, slackConfigured } from "./slack";
import {
  slugify,
  computeProgress,
  checkoffMessage,
  completionMessage,
} from "../../shared/onboarding.mjs";

type Row = Record<string, unknown>;

export type OnboardingTask = {
  id: string;
  parentId: string | null;
  templateStepId: string | null;
  section: string | null;
  title: string;
  description: string | null;
  position: number;
  isDone: boolean;
  doneBy: string | null;
  doneAt: string | null;
};

export type TemplateStep = {
  id: string;
  parentId: string | null;
  section: string | null;
  title: string;
  description: string | null;
  position: number;
  isActive: boolean;
};

export type OnboardingClient = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  accentColor: string | null;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  progress: { doneLeaves: number; totalLeaves: number; pct: number; complete: boolean };
};

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const num = (value: unknown) => (typeof value === "number" ? value : Number(value) || 0);

function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
function authHeaders(key: string, write = false) {
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}` };
  if (write) {
    headers["content-type"] = "application/json";
    headers.Prefer = "return=representation";
  }
  return headers;
}

/** PostgREST is unreachable-configured is an error the caller shows; a query that fails is [] so a read never throws. */
async function rows(url: string, key: string, path: string): Promise<Row[]> {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: authHeaders(key), cache: "no-store" });
  if (!response.ok) return [];
  const body = await response.json().catch(() => []);
  return Array.isArray(body) ? (body as Row[]) : [];
}

function taskFromRow(row: Row): OnboardingTask {
  return {
    id: str(row.id),
    parentId: row.parent_id ? str(row.parent_id) : null,
    templateStepId: row.template_step_id ? str(row.template_step_id) : null,
    section: row.section ? str(row.section) : null,
    title: str(row.title),
    description: row.description ? str(row.description) : null,
    position: num(row.position),
    isDone: Boolean(row.is_done),
    doneBy: row.done_by ? str(row.done_by) : null,
    doneAt: row.done_at ? str(row.done_at) : null,
  };
}
function templateFromRow(row: Row): TemplateStep {
  return {
    id: str(row.id),
    parentId: row.parent_id ? str(row.parent_id) : null,
    section: row.section ? str(row.section) : null,
    title: str(row.title),
    description: row.description ? str(row.description) : null,
    position: num(row.position),
    isActive: row.is_active !== false,
  };
}

// ── Directory ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every client that came in through the hub, newest first, each with its progress. Two queries rather than
 * one per client: the workspaces that are onboarding, then all of their tasks in a single `in.()`, grouped
 * in memory. A workspace with `onboarding_status` set but no tasks yet still shows, at 0%.
 */
export async function listOnboardingClients(): Promise<OnboardingClient[]> {
  const { url, key } = config();
  if (!url || !key) return [];
  // Every client, not only the ones added through the hub: the whole directory belongs here, ranked by how
  // far along onboarding is. An established client simply starts at 0% and gets its checklist the first time
  // someone opens it (see getOnboardingClient's lazy snapshot).
  const workspaces = await rows(
    url,
    key,
    `rr_workspaces?select=id,name,slug,logo_url,accent_color,onboarding_status,onboarding_started_at,onboarding_completed_at&order=name.asc`,
  );
  const named = workspaces.filter((w) => str(w.name).trim());
  if (!named.length) return [];
  const ids = named.map((w) => str(w.id)).filter(Boolean);
  const [taskRows, templateLeaves] = await Promise.all([
    ids.length ? rows(url, key, `rr_onboarding_tasks?select=id,workspace_id,parent_id,is_done&workspace_id=in.(${ids.map(encodeURIComponent).join(",")})`) : Promise.resolve([] as Row[]),
    templateLeafCount(url, key),
  ]);
  const byWorkspace = new Map<string, Array<{ id: string; parentId: string | null; isDone: boolean }>>();
  for (const row of taskRows) {
    const wid = str(row.workspace_id);
    const list = byWorkspace.get(wid) ?? [];
    list.push({ id: str(row.id), parentId: row.parent_id ? str(row.parent_id) : null, isDone: Boolean(row.is_done) });
    byWorkspace.set(wid, list);
  }
  const clients = named.map((w) => {
    const id = str(w.id);
    const tasks = byWorkspace.get(id) ?? [];
    // A client not yet snapshotted has no tasks; show the template's own leaf count as the denominator so
    // its bar and its rank read correctly before the first open fills it in.
    const progress = tasks.length ? computeProgress(tasks) : { doneLeaves: 0, totalLeaves: templateLeaves, pct: 0, complete: false };
    return {
      id,
      name: str(w.name),
      slug: str(w.slug),
      logoUrl: w.logo_url ? str(w.logo_url) : null,
      accentColor: w.accent_color ? str(w.accent_color) : null,
      status: w.onboarding_status ? str(w.onboarding_status) : null,
      startedAt: w.onboarding_started_at ? str(w.onboarding_started_at) : null,
      completedAt: w.onboarding_completed_at ? str(w.onboarding_completed_at) : null,
      progress,
    };
  });
  return clients.sort((a, b) => b.progress.pct - a.progress.pct || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** How many active template steps are leaves — the denominator a client shows before it is snapshotted. */
async function templateLeafCount(url: string, key: string): Promise<number> {
  const steps = await rows(url, key, `rr_onboarding_template_steps?select=id,parent_id&is_active=eq.true`);
  const parents = new Set(steps.filter((s) => s.parent_id).map((s) => str(s.parent_id)));
  return steps.filter((s) => !parents.has(str(s.id))).length;
}

/**
 * One client with its full ordered checklist, or null if the slug is not a workspace at all.
 *
 * Lazily snapshots the template the first time a client is opened with no steps: this is what lets an
 * established client — or one added before the template existed — get its checklist on first view instead
 * of sitting empty. Opening it also marks the client `in_progress` if it had no onboarding status yet. The
 * snapshot only runs when the checklist is genuinely empty, so re-opening never duplicates or resurrects
 * steps the teammate deliberately cleared in the same session's work.
 */
export async function getOnboardingClient(slug: string): Promise<{ client: OnboardingClient; tasks: OnboardingTask[] } | null> {
  const { url, key } = config();
  if (!url || !key) return null;
  const workspaces = await rows(
    url,
    key,
    `rr_workspaces?select=id,name,slug,logo_url,accent_color,onboarding_status,onboarding_started_at,onboarding_completed_at&slug=eq.${encodeURIComponent(slug)}&limit=1`,
  );
  const w = workspaces[0];
  if (!w) return null;
  const id = str(w.id);
  let taskRows = await rows(url, key, `rr_onboarding_tasks?select=*&workspace_id=eq.${encodeURIComponent(id)}&order=position.asc`);
  let status = w.onboarding_status ? str(w.onboarding_status) : null;
  let startedAt = w.onboarding_started_at ? str(w.onboarding_started_at) : null;
  if (!taskRows.length) {
    await snapshotTemplate(url, key, id);
    taskRows = await rows(url, key, `rr_onboarding_tasks?select=*&workspace_id=eq.${encodeURIComponent(id)}&order=position.asc`);
    if (taskRows.length && !status) {
      status = "in_progress";
      startedAt = new Date().toISOString();
      await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: authHeaders(key), body: JSON.stringify({ onboarding_status: "in_progress", onboarding_started_at: startedAt }) }).catch(() => {});
    }
  }
  const tasks = taskRows.map(taskFromRow);
  return {
    client: {
      id,
      name: str(w.name),
      slug: str(w.slug),
      logoUrl: w.logo_url ? str(w.logo_url) : null,
      accentColor: w.accent_color ? str(w.accent_color) : null,
      status,
      startedAt,
      completedAt: w.onboarding_completed_at ? str(w.onboarding_completed_at) : null,
      progress: computeProgress(tasks),
    },
    tasks,
  };
}

// ── Add a client ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Copy the active template into a new client's checklist. Two inserts, not one per row: the parents first,
 * with `template_step_id` set so each returned row can be matched back to the template step it came from,
 * then the children with `parent_id` remapped through that match. Positions and sections are carried across
 * verbatim, so the client's list opens in the same ranked order the template is in.
 */
async function snapshotTemplate(url: string, key: string, workspaceId: string): Promise<void> {
  const steps = (await rows(url, key, `rr_onboarding_template_steps?select=*&is_active=eq.true&order=position.asc`)).map(templateFromRow);
  if (!steps.length) return;
  const parents = steps.filter((s) => !s.parentId);
  const children = steps.filter((s) => s.parentId);

  const parentPayload = parents.map((s) => ({
    workspace_id: workspaceId,
    template_step_id: s.id,
    section: s.section,
    title: s.title,
    description: s.description,
    position: s.position,
  }));
  const inserted = parentPayload.length
    ? await fetch(`${url}/rest/v1/rr_onboarding_tasks`, { method: "POST", headers: authHeaders(key, true), body: JSON.stringify(parentPayload) })
    : null;
  const insertedRows: Row[] = inserted && inserted.ok ? await inserted.json().catch(() => []) : [];
  // template step id → the new task id, so a child can find its freshly-created parent.
  const taskIdByTemplateId = new Map<string, string>();
  for (const row of insertedRows) taskIdByTemplateId.set(str(row.template_step_id), str(row.id));

  const childPayload = children
    .map((s) => {
      const parentTaskId = taskIdByTemplateId.get(str(s.parentId));
      if (!parentTaskId) return null; // a child whose parent is inactive/missing is skipped, not orphaned.
      return {
        workspace_id: workspaceId,
        template_step_id: s.id,
        parent_id: parentTaskId,
        section: s.section,
        title: s.title,
        description: s.description,
        position: s.position,
      };
    })
    .filter(Boolean);
  if (childPayload.length) {
    await fetch(`${url}/rest/v1/rr_onboarding_tasks`, { method: "POST", headers: authHeaders(key, true), body: JSON.stringify(childPayload) });
  }
}

/**
 * Add a client to the hub: a new `rr_workspaces` row marked `in_progress`, then a snapshot of the template
 * into its checklist. The slug is derived from the name and made unique by suffix, so two "Acme"s do not
 * collide (and a merge-duplicates insert does not silently adopt an existing client's row).
 */
export async function addOnboardingClient(input: { name: string; logoUrl?: string; accentColor?: string }): Promise<{ ok: boolean; error?: string; client?: OnboardingClient }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const name = str(input.name).trim();
  if (!name) return { ok: false, error: "A client name is required." };
  const base = slugify(name) || "client";

  // Find a free slug up front, then insert without merge-duplicates so a race that still collides errors
  // rather than quietly writing onto an existing client.
  const taken = new Set(
    (await rows(url, key, `rr_workspaces?select=slug&slug=like.${encodeURIComponent(base + "*")}`)).map((r) => str(r.slug)),
  );
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;

  const record = {
    name,
    slug,
    logo_url: str(input.logoUrl).trim() || null,
    accent_color: str(input.accentColor).trim() || null,
    onboarding_status: "in_progress",
    onboarding_started_at: new Date().toISOString(),
  };
  const response = await fetch(`${url}/rest/v1/rr_workspaces`, { method: "POST", headers: authHeaders(key, true), body: JSON.stringify(record) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, error: detail || "Could not create the client workspace." };
  }
  const created = (await response.json().catch(() => []))[0] as Row | undefined;
  if (!created) return { ok: false, error: "The client workspace was not created." };
  const id = str(created.id);
  await snapshotTemplate(url, key, id);
  return {
    ok: true,
    client: {
      id,
      name,
      slug,
      logoUrl: record.logo_url,
      accentColor: record.accent_color,
      status: "in_progress",
      startedAt: record.onboarding_started_at,
      completedAt: null,
      progress: { doneLeaves: 0, totalLeaves: 0, pct: 0, complete: false },
    },
  };
}

/** Remove a client from the hub. Deletes the workspace; the tasks cascade with it. */
export async function deleteOnboardingClient(slug: string): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const response = await fetch(`${url}/rest/v1/rr_workspaces?slug=eq.${encodeURIComponent(slug)}`, { method: "DELETE", headers: authHeaders(key) });
  if (!response.ok) return { ok: false, error: "Could not delete the client." };
  return { ok: true };
}

// ── Check a task off ─────────────────────────────────────────────────────────────────────────────────

/**
 * Mark one task done or not-done. On a transition to done, and only then, a line is posted to the client's
 * internal Slack channel; when that checkoff is the last leaf, the workspace flips to `complete` and a
 * second, celebratory line is posted. Un-checking after completion quietly reopens the client. The Slack
 * post is best-effort — a channel that is not set yet (its own step is on this very list) or a Slack outage
 * must never turn a checkoff into an error, so the checkbox saving is what the return value reflects.
 */
export async function setTaskDone(input: { taskId: string; isDone: boolean; doneBy?: string }): Promise<{ ok: boolean; error?: string; progress?: ReturnType<typeof computeProgress> }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const taskId = str(input.taskId).trim();
  if (!taskId) return { ok: false, error: "A task id is required." };
  const isDone = Boolean(input.isDone);
  const doneBy = str(input.doneBy).trim();

  const patch = {
    is_done: isDone,
    done_at: isDone ? new Date().toISOString() : null,
    done_by: isDone ? doneBy || null : null,
  };
  const response = await fetch(`${url}/rest/v1/rr_onboarding_tasks?id=eq.${encodeURIComponent(taskId)}`, { method: "PATCH", headers: authHeaders(key, true), body: JSON.stringify(patch) });
  if (!response.ok) return { ok: false, error: "Could not update the task." };
  const updated = (await response.json().catch(() => []))[0] as Row | undefined;
  if (!updated) return { ok: false, error: "That task no longer exists." };
  const workspaceId = str(updated.workspace_id);

  // The whole checklist and the workspace, to recompute progress from the source of truth rather than trust
  // the browser's copy, and to have the parent's title and the client's name for the Slack line.
  const [allTaskRows, workspaceRows] = await Promise.all([
    rows(url, key, `rr_onboarding_tasks?select=id,parent_id,is_done,title&workspace_id=eq.${encodeURIComponent(workspaceId)}`),
    rows(url, key, `rr_workspaces?select=id,name,slack_internal_channel_id,onboarding_status&id=eq.${encodeURIComponent(workspaceId)}&limit=1`),
  ]);
  const tasks = allTaskRows.map((r) => ({ id: str(r.id), parentId: r.parent_id ? str(r.parent_id) : null, isDone: Boolean(r.is_done), title: str(r.title) }));
  const progress = computeProgress(tasks);
  const workspace = workspaceRows[0];
  const clientName = str(workspace?.name);
  const channelId = str(workspace?.slack_internal_channel_id);
  const wasComplete = str(workspace?.onboarding_status) === "complete";

  // Flip the workspace status to match the new progress, both directions.
  if (progress.complete && !wasComplete) {
    await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(workspaceId)}`, { method: "PATCH", headers: authHeaders(key), body: JSON.stringify({ onboarding_status: "complete", onboarding_completed_at: new Date().toISOString() }) }).catch(() => {});
  } else if (!progress.complete && wasComplete) {
    await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(workspaceId)}`, { method: "PATCH", headers: authHeaders(key), body: JSON.stringify({ onboarding_status: "in_progress", onboarding_completed_at: null }) }).catch(() => {});
  }

  // Slack, only on completing something, only when there is a channel to post to.
  if (isDone && channelId && slackConfigured()) {
    const parent = updated.parent_id ? tasks.find((t) => t.id === str(updated.parent_id)) : undefined;
    const line = checkoffMessage({
      clientName,
      taskTitle: str(updated.title),
      parentTitle: parent?.title,
      doneBy,
      doneLeaves: progress.doneLeaves,
      totalLeaves: progress.totalLeaves,
      pct: progress.pct,
    });
    await postMessage(channelId, line).catch(() => {});
    if (progress.complete && !wasComplete) {
      await postMessage(channelId, completionMessage({ clientName, totalLeaves: progress.totalLeaves, doneBy })).catch(() => {});
    }
  }

  return { ok: true, progress };
}

// ── Template CRUD (the "client template box") ──────────────────────────────────────────────────────────

/** The whole template, ordered — parents and their sub-steps, active and inactive. */
export async function listTemplate(): Promise<TemplateStep[]> {
  const { url, key } = config();
  if (!url || !key) return [];
  return (await rows(url, key, `rr_onboarding_template_steps?select=*&order=position.asc`)).map(templateFromRow);
}

export async function addTemplateStep(input: { title: string; section?: string; description?: string; parentId?: string; position?: number }): Promise<{ ok: boolean; error?: string; step?: TemplateStep }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const title = str(input.title).trim();
  if (!title) return { ok: false, error: "A step needs a title." };
  const record = {
    title,
    section: str(input.section).trim() || null,
    description: str(input.description).trim() || null,
    parent_id: str(input.parentId).trim() || null,
    position: typeof input.position === "number" ? input.position : 0,
  };
  const response = await fetch(`${url}/rest/v1/rr_onboarding_template_steps`, { method: "POST", headers: authHeaders(key, true), body: JSON.stringify(record) });
  if (!response.ok) return { ok: false, error: "Could not add the step." };
  const created = (await response.json().catch(() => []))[0] as Row | undefined;
  return created ? { ok: true, step: templateFromRow(created) } : { ok: false, error: "The step was not created." };
}

export async function updateTemplateStep(id: string, patch: { title?: string; section?: string | null; description?: string | null; isActive?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const stepId = str(id).trim();
  if (!stepId) return { ok: false, error: "A step id is required." };
  const record: Row = {};
  if (typeof patch.title === "string") record.title = patch.title.trim();
  if ("section" in patch) record.section = str(patch.section).trim() || null;
  if ("description" in patch) record.description = str(patch.description).trim() || null;
  if (typeof patch.isActive === "boolean") record.is_active = patch.isActive;
  if (!Object.keys(record).length) return { ok: true };
  const response = await fetch(`${url}/rest/v1/rr_onboarding_template_steps?id=eq.${encodeURIComponent(stepId)}`, { method: "PATCH", headers: authHeaders(key), body: JSON.stringify(record) });
  return response.ok ? { ok: true } : { ok: false, error: "Could not save the step." };
}

export async function deleteTemplateStep(id: string): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const stepId = str(id).trim();
  if (!stepId) return { ok: false, error: "A step id is required." };
  const response = await fetch(`${url}/rest/v1/rr_onboarding_template_steps?id=eq.${encodeURIComponent(stepId)}`, { method: "DELETE", headers: authHeaders(key) });
  return response.ok ? { ok: true } : { ok: false, error: "Could not delete the step." };
}

/** Persist a reordered sibling group: one PATCH per id, setting its new evenly-spaced position. */
export async function reorderTemplate(order: Array<{ id: string; position: number }>): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  for (const { id, position } of order) {
    await fetch(`${url}/rest/v1/rr_onboarding_template_steps?id=eq.${encodeURIComponent(str(id))}`, { method: "PATCH", headers: authHeaders(key), body: JSON.stringify({ position }) }).catch(() => {});
  }
  return { ok: true };
}
