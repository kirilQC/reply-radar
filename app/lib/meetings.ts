// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The I/O half of booked meetings: the client directory, one client's meetings, adding one by hand or from
 * the assistant, and ingesting the Zapier/Calendly webhook. The flexible payload mapping it leans on is the
 * pure export of `shared/meetings.mjs`; everything here is the Supabase side of it.
 *
 * The webhook is routed by client NAME, because that is the one field a person wiring a Zap can reliably set —
 * so `resolveWorkspace` accepts a slug, an exact name, or an unambiguous partial, and refuses rather than
 * guesses when a name matches two clients, so a meeting is never filed under the wrong company.
 */

import { normalizeMeeting, meetingIsUsable } from "../../shared/meetings.mjs";

type Row = Record<string, unknown>;

export type Meeting = {
  id: string;
  inviteeName: string | null;
  inviteeEmail: string | null;
  inviteeLinkedin: string | null;
  inviteeTitle: string | null;
  inviteeLocation: string | null;
  inviteeHeadline: string | null;
  companyName: string | null;
  companyDomain: string | null;
  companyLinkedin: string | null;
  companyLocation: string | null;
  companyIndustry: string | null;
  companySize: string | null;
  companyType: string | null;
  companyDescription: string | null;
  meetingAt: string | null;
  whenText: string | null;
  summary: string | null;
  host: string | null;
  campaign: string | null;
  status: string;
  source: string;
  createdAt: string;
};

export type MeetingClient = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  accentColor: string | null;
  total: number;
  upcoming: number;
  nextAt: string | null;
  lastAt: string | null;
};

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const orNull = (value: unknown) => (str(value).trim() ? str(value) : null);

// The columns a caller may set. Anything else in an incoming object is ignored, so a webhook or form cannot
// write to a column it was not meant to.
const COLUMNS = new Set([
  "invitee_name", "invitee_email", "invitee_linkedin", "invitee_title", "invitee_location", "invitee_headline",
  "company_name", "company_domain", "company_linkedin", "company_location", "company_industry", "company_size",
  "company_type", "company_description", "meeting_at", "when_text", "summary", "host", "campaign", "status", "external_id", "raw",
]);

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
async function rows(url: string, key: string, path: string): Promise<Row[]> {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: authHeaders(key), cache: "no-store" });
  if (!response.ok) return [];
  const body = await response.json().catch(() => []);
  return Array.isArray(body) ? (body as Row[]) : [];
}

function meetingFromRow(row: Row): Meeting {
  return {
    id: str(row.id),
    inviteeName: orNull(row.invitee_name),
    inviteeEmail: orNull(row.invitee_email),
    inviteeLinkedin: orNull(row.invitee_linkedin),
    inviteeTitle: orNull(row.invitee_title),
    inviteeLocation: orNull(row.invitee_location),
    inviteeHeadline: orNull(row.invitee_headline),
    companyName: orNull(row.company_name),
    companyDomain: orNull(row.company_domain),
    companyLinkedin: orNull(row.company_linkedin),
    companyLocation: orNull(row.company_location),
    companyIndustry: orNull(row.company_industry),
    companySize: orNull(row.company_size),
    companyType: orNull(row.company_type),
    companyDescription: orNull(row.company_description),
    meetingAt: orNull(row.meeting_at),
    whenText: orNull(row.when_text),
    summary: orNull(row.summary),
    host: orNull(row.host),
    campaign: orNull(row.campaign),
    status: str(row.status) || "scheduled",
    source: str(row.source) || "manual",
    createdAt: str(row.created_at),
  };
}

type Workspace = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };

/** The client a name, slug or unambiguous partial refers to, or null. Ambiguity returns null, never a guess. */
export async function resolveWorkspace(nameOrSlug: string): Promise<Workspace | null> {
  const { url, key } = config();
  if (!url || !key) return null;
  const wanted = str(nameOrSlug).trim().toLowerCase();
  if (!wanted) return null;
  const all = (await rows(url, key, `rr_workspaces?select=id,name,slug,logo_url,accent_color&order=name.asc`)).map((row) => ({
    id: str(row.id),
    name: str(row.name),
    slug: str(row.slug),
    logoUrl: orNull(row.logo_url),
    accentColor: orNull(row.accent_color),
  }));
  const exact = all.filter((w) => w.slug.toLowerCase() === wanted || w.name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = all.filter((w) => w.name.toLowerCase().includes(wanted) || w.slug.toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

/** Every client with a meeting count, how many are still upcoming, and the next/most-recent times. */
export async function listMeetingClients(): Promise<MeetingClient[]> {
  const { url, key } = config();
  if (!url || !key) return [];
  const workspaces = (await rows(url, key, `rr_workspaces?select=id,name,slug,logo_url,accent_color&order=name.asc`)).filter((w) => str(w.name).trim());
  if (!workspaces.length) return [];
  const meetings = await rows(url, key, `rr_meetings?select=workspace_id,meeting_at,status`);
  const now = Date.now();
  const byWorkspace = new Map<string, { total: number; upcoming: number; next: number | null; last: number | null }>();
  for (const row of meetings) {
    const wid = str(row.workspace_id);
    const entry = byWorkspace.get(wid) ?? { total: 0, upcoming: 0, next: null, last: null };
    entry.total += 1;
    const at = row.meeting_at ? Date.parse(str(row.meeting_at)) : NaN;
    const canceled = str(row.status) === "canceled";
    if (!Number.isNaN(at)) {
      if (entry.last === null || at > entry.last) entry.last = at;
      if (!canceled && at >= now && (entry.next === null || at < entry.next)) entry.next = at;
      if (!canceled && at >= now) entry.upcoming += 1;
    }
    byWorkspace.set(wid, entry);
  }
  return workspaces
    .map((w) => {
      const id = str(w.id);
      const m = byWorkspace.get(id) ?? { total: 0, upcoming: 0, next: null, last: null };
      return {
        id,
        name: str(w.name),
        slug: str(w.slug),
        logoUrl: orNull(w.logo_url),
        accentColor: orNull(w.accent_color),
        total: m.total,
        upcoming: m.upcoming,
        nextAt: m.next ? new Date(m.next).toISOString() : null,
        lastAt: m.last ? new Date(m.last).toISOString() : null,
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** One client and its meetings, soonest upcoming first then most recent past, or null if the slug is unknown. */
export async function getClientMeetings(slug: string): Promise<{ client: Workspace; meetings: Meeting[] } | null> {
  const { url, key } = config();
  if (!url || !key) return null;
  const workspaces = await rows(url, key, `rr_workspaces?select=id,name,slug,logo_url,accent_color&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  const w = workspaces[0];
  if (!w) return null;
  const id = str(w.id);
  const rowsData = await rows(url, key, `rr_meetings?select=*&workspace_id=eq.${encodeURIComponent(id)}&order=meeting_at.desc.nullslast,created_at.desc`);
  return {
    client: { id, name: str(w.name), slug: str(w.slug), logoUrl: orNull(w.logo_url), accentColor: orNull(w.accent_color) },
    meetings: rowsData.map(meetingFromRow),
  };
}

/** Build the DB record from a caller's fields, keeping only real columns. */
function record(workspaceId: string, source: string, fields: Record<string, unknown>): Row {
  const out: Row = { workspace_id: workspaceId, source };
  for (const [k, v] of Object.entries(fields)) {
    if (!COLUMNS.has(k)) continue;
    if (k === "raw") { out.raw = v && typeof v === "object" ? v : {}; continue; }
    if (k === "status") { out.status = str(v) || "scheduled"; continue; }
    out[k] = orNull(v);
  }
  return out;
}

/** Add a meeting to a client by slug (the manual-add and assistant path). */
export async function addMeeting(slug: string, fields: Record<string, unknown>, source = "manual"): Promise<{ ok: boolean; error?: string; meeting?: Meeting }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const client = await resolveWorkspace(slug);
  if (!client) return { ok: false, error: `No single client matches "${slug}".` };
  if (!meetingIsUsable(fields)) return { ok: false, error: "A meeting needs at least an invitee name, email or company." };
  const response = await fetch(`${url}/rest/v1/rr_meetings`, { method: "POST", headers: authHeaders(key, true), body: JSON.stringify(record(client.id, source, fields)) });
  if (!response.ok) return { ok: false, error: "Could not save the meeting." };
  const created = (await response.json().catch(() => []))[0] as Row | undefined;
  return created ? { ok: true, meeting: meetingFromRow(created) } : { ok: false, error: "The meeting was not created." };
}

/** Remove one meeting. */
export async function deleteMeeting(id: string): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const response = await fetch(`${url}/rest/v1/rr_meetings?id=eq.${encodeURIComponent(str(id))}`, { method: "DELETE", headers: authHeaders(key) });
  return response.ok ? { ok: true } : { ok: false, error: "Could not delete the meeting." };
}

/**
 * Ingest a webhook payload: map it, find the client by the name in it, then upsert. When the payload carries a
 * Calendly event id, the write is keyed on (workspace, external_id) so a reschedule updates the existing row
 * instead of adding a duplicate; without one it is a plain insert.
 */
export async function ingestWebhook(payload: unknown): Promise<{ ok: boolean; error?: string; client?: string; meeting?: Meeting }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const { client: clientName, fields } = normalizeMeeting((payload ?? {}) as Record<string, unknown>);
  if (!str(clientName).trim()) return { ok: false, error: "The payload has no client field to route on. Add a 'client' variable with the client's name." };
  const client = await resolveWorkspace(clientName);
  if (!client) return { ok: false, error: `No single Reply Radar client matches "${clientName}". Check the client name sent from Zapier.` };
  if (!meetingIsUsable(fields)) return { ok: false, error: "The payload had no invitee name, email or company to record." };

  const body = record(client.id, "webhook", fields);
  const hasExternal = Boolean(str(fields.external_id).trim());
  const endpoint = hasExternal
    ? `${url}/rest/v1/rr_meetings?on_conflict=workspace_id,external_id`
    : `${url}/rest/v1/rr_meetings`;
  const headers = { ...authHeaders(key, true), ...(hasExternal ? { Prefer: "resolution=merge-duplicates,return=representation" } : {}) };
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("reply_radar_meeting_webhook_failed", { client: client.slug, status: response.status, detail: detail.slice(0, 300) });
    return { ok: false, error: "Could not save the meeting." };
  }
  const created = (await response.json().catch(() => []))[0] as Row | undefined;
  return { ok: true, client: client.name, meeting: created ? meetingFromRow(created) : undefined };
}
