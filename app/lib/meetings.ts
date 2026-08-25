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
import { normalizeLinkedin } from "../../shared/deal-attribution.mjs";
import { enrichLeadWithAiArk } from "./ai-ark-enrichment";
import { isAiArkEnrichmentEnabled } from "./lead-identity";

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
  // content-type is always set — PostgREST ignores a PATCH/POST body without it. Harmless on a GET.
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  if (write) headers.Prefer = "return=representation";
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

/** One meeting by id, or null. */
export async function getMeeting(id: string): Promise<Meeting | null> {
  const { url, key } = config();
  if (!url || !key || !id) return null;
  const row = (await rows(url, key, `rr_meetings?select=*&id=eq.${encodeURIComponent(id)}&limit=1`))[0];
  return row ? meetingFromRow(row) : null;
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

// ── Enrichment ─────────────────────────────────────────────────────────────────────────────────────

const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

/** The bare domain out of a website URL: "https://www.acme.io/about" → "acme.io". */
function domainFromWebsite(website: unknown): string | null {
  const s = str(website).trim();
  if (!s) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** A location object or string reduced to "City, Region, Country", or null. */
function locationLabel(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.trim() || null;
  const o = obj(value);
  const parts = [o.city, o.state || o.region || o.geographicArea, o.country]
    .map((part) => str(part).trim())
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join(", ") : null;
}

/** AI Ark's staff figures turned into a readable size, or null. */
function companySizeLabel(summary: Row): string | null {
  const staff = obj(summary.staff);
  const range = obj(staff.range);
  const start = str(range.start).trim();
  const end = str(range.end).trim();
  if (start || end) return `${start || "?"}–${end || "?"} employees`;
  if (staff.total) return `${Number(staff.total).toLocaleString()} employees`;
  return null;
}

/**
 * Map a person's AI Ark enrichment onto the meeting's empty columns.
 *
 * The nested shape is exactly what the database drawer reads: person fields at the top, the company block
 * under `company` with `summary`, `link` and `location`. Only columns the meeting does not already have are
 * filled, so anything the Zap mapped by hand is never overwritten.
 */
function enrichmentPatch(meetingRow: Row, enrichment: Row): Row {
  const company = obj(enrichment.company);
  const summary = obj(company.summary);
  const link = obj(company.link);
  const candidates: Record<string, string | null> = {
    invitee_location: locationLabel(enrichment.location),
    invitee_headline: str(enrichment.headline).trim() || null,
    invitee_title: str(enrichment.title).trim() || null,
    company_name: (str(summary.name) || str(company.name)).trim() || null,
    company_domain: domainFromWebsite(link.website),
    company_linkedin: str(link.linkedin).trim() || null,
    company_location: locationLabel(obj(company.location).headquarter),
    company_industry: (str(summary.industry) || str(company.industry) || str(enrichment.industry)).trim() || null,
    company_size: companySizeLabel(summary),
    company_type: (str(summary.type) || str(company.type)).trim() || null,
    company_description: str(summary.description).trim() || null,
  };
  const patch: Row = {};
  for (const [column, value] of Object.entries(candidates)) {
    if (value && !orNull(meetingRow[column])) patch[column] = value;
  }
  return patch;
}

/**
 * Fill a booked meeting's enrichment from what we already know about the person, or from AI Ark.
 *
 * A meeting almost always arrives with only a name, email and LinkedIn URL; the location, headline and the
 * whole company block come in empty. Since every lead we have contacted carries a full AI Ark enrichment on
 * their `rr_leads` row, the cheap path is to find that person by their LinkedIn URL and copy their enrichment
 * across. Only when the person is not in our database yet (rare) do we spend an AI Ark call to enrich them
 * fresh — and only if enrichment is switched on.
 *
 * Non-destructive: only empty columns are filled, so anything the Zap already mapped is left alone. Best
 * effort — a miss (no LinkedIn, no match, service down) leaves the meeting exactly as it was and never throws.
 */
export async function enrichMeeting(meetingId: string): Promise<boolean> {
  const { url, key } = config();
  if (!url || !key || !meetingId) return false;
  const meetingRow = (await rows(url, key, `rr_meetings?select=*&id=eq.${encodeURIComponent(meetingId)}&limit=1`))[0];
  if (!meetingRow) return false;
  const linkedin = str(meetingRow.invitee_linkedin).trim();
  if (!linkedin) return false; // no LinkedIn URL to look up on
  const handle = normalizeLinkedin(linkedin);

  // 1. The common path: the person is already a lead we contacted, with a full enrichment on their row.
  let enrichment: Row | null = null;
  if (handle) {
    const leadRows = await rows(url, key, `rr_leads?select=raw_data&linkedin_profile_url=ilike.*${encodeURIComponent(handle)}*&limit=10`);
    for (const lead of leadRows) {
      const aiArk = obj(obj(obj(lead.raw_data).reply_radar).ai_ark);
      if (Object.keys(aiArk).length > 0) { enrichment = aiArk; break; }
    }
  }

  // 2. The rare path: not in our database yet, so enrich them fresh from AI Ark — only if it is turned on.
  if (!enrichment && isAiArkEnrichmentEnabled()) {
    try {
      enrichment = (await enrichLeadWithAiArk({ url, key }, str(meetingRow.workspace_id), linkedin, str(meetingRow.company_name))) as Row;
    } catch {
      enrichment = null; // no match, or the service was unavailable — leave the meeting untouched
    }
  }
  if (!enrichment) return false;

  const patch = enrichmentPatch(meetingRow, enrichment);
  if (Object.keys(patch).length === 0) return false;
  const response = await fetch(`${url}/rest/v1/rr_meetings?id=eq.${encodeURIComponent(meetingId)}`, {
    method: "PATCH", headers: authHeaders(key), body: JSON.stringify(patch),
  });
  return response.ok;
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
