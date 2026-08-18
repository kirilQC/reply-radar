// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Airtable's Web API, and the two questions this file asks it: which bases exist, and is this one's
 * project tracker shaped the way the morning brief will need to write into it.
 *
 * ── Why the schema is read every time rather than hardcoded ───────────────────────────────────────
 * Every client base was duplicated from one template, so the table id is genuinely shared:
 * `tblb3uziiRyZD2AMi` is the tracker in the template, in Willow, in Bluevia and in Cotool. The field
 * ids are *mostly* shared too, which is the trap. `Responsibility` is `fldmkbCNSmuWrUpAv` in the
 * template and Bluevia, `flduW9ie98PnnBH9p` in Willow and `fldKDlx0fgGCF18Pz` in Cotool — and
 * Cotool's choices are `QC / Client` where everyone else's are `Sales Lead / Luke / GTM Eng /
 * Operations`. Same name, same position, different meaning.
 *
 * Hardcoding a field id would therefore work for three clients and write into the wrong column for
 * the fourth, which is the worst available outcome: silent, plausible and only visible to the client.
 * So tables are addressed by id where we can and by name where we must, and every field is resolved
 * against the live schema at the moment it is used.
 *
 * ── Why `typecast` is never set ───────────────────────────────────────────────────────────────────
 * With `typecast: true` an unrecognised select value does not fail, it *creates the option*. The
 * choice sets have already drifted — Cotool has no `Completed`, Bluevia has both `Completed` and
 * `Done` plus an option with an empty name — so a writer that typecasts would invent a new status in
 * a client's base the first morning it ran. Off, an unknown value is a clean 422 and we skip the
 * field. Refusing to write one cell is recoverable; inventing vocabulary in somebody else's tracker
 * is not.
 *
 * ── Nothing here retries ──────────────────────────────────────────────────────────────────────────
 * Airtable's 429 is not a "wait a moment" — it locks the token out of that base for a full thirty
 * seconds. There is no backoff that fits inside a request somebody is watching, so the rate limit is
 * reported rather than absorbed. The write path, when it exists, runs in the worker and can afford
 * the thirty seconds; this path cannot and should not pretend to.
 */

const BASE = "https://api.airtable.com/v0";
/** Airtable is normally fast; this exists so a hung meta call cannot hold an admin screen open. */
const TIMEOUT_MS = 8_000;

/**
 * The tracker's table id, shared by every base duplicated from the client template.
 *
 * Tried first because it survives the table being renamed, which has already happened once: the
 * template calls it `Campaigns & Projects` and every live client base calls it
 * `Campaigns & Projects Tracker`. A base built from scratch rather than duplicated will not have this
 * id, so the name is tried second.
 */
export const TRACKER_TABLE_ID = "tblb3uziiRyZD2AMi";
/** Matched loosely, lowercased: the suffix differs between the template and the client bases. */
const TRACKER_NAME_NEEDLE = "campaigns & projects";

/**
 * The fields the brief needs in order to write an action item, and the type each has to be.
 *
 * Deliberately the small set that is identical across all four bases inspected. `Responsibility` and
 * `Priority` are *not* here despite existing in most client bases: their field ids differ per base,
 * Cotool's `Responsibility` means something else entirely, and `Priority` is absent from the template.
 * A field we cannot interpret the same way everywhere is not a field the brief can fill.
 */
export const REQUIRED_TRACKER_FIELDS: { name: string; type: string; why: string }[] = [
  { name: "Title", type: "singleLineText", why: "the action item itself" },
  { name: "Status", type: "singleSelect", why: "so a finished item can be closed" },
  { name: "Type", type: "singleSelect", why: "so brief items are separable from campaigns" },
  { name: "Assignee", type: "singleCollaborator", why: "who owes it" },
  { name: "Comments", type: "multilineText", why: "why the brief raised it" },
  { name: "Due Date", type: "date", why: "when it is owed" },
];

export type AirtableBase = { id: string; name: string; permissionLevel?: string };

export type AirtableField = { id: string; name: string; type: string; options?: { choices?: { id: string; name: string }[] } };

export type AirtableTable = { id: string; name: string; primaryFieldId?: string; fields?: AirtableField[] };

export type AirtableResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export function isAirtableConfigured() {
  return Boolean(process.env.AIRTABLE_API_KEY);
}

async function airtableGet<T>(path: string): Promise<AirtableResult<T>> {
  const token = process.env.AIRTABLE_API_KEY;
  if (!token) return { ok: false, error: "No Airtable token is set. Add AIRTABLE_API_KEY.", status: 503 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) {
      // Said in the terms of the thing somebody has to go and change, because every one of these is a
      // token setting rather than a bug in the code above.
      const detail = (body as { error?: { message?: string; type?: string } })?.error;
      const message =
        response.status === 401 ? "Airtable rejected the token. Check AIRTABLE_API_KEY."
          : response.status === 403 ? "The token cannot see this base. Add it under the token's Access list, or set the token to all current and future bases."
            : response.status === 429 ? "Airtable rate limit hit. It clears after 30 seconds."
              : String(detail?.message || detail?.type || `Airtable returned ${response.status}.`);
      return { ok: false, error: message, status: response.status };
    }
    return { ok: true, data: body as T };
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    return { ok: false, error: aborted ? "Airtable did not respond in time." : "Airtable could not be reached.", status: 504 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every base the token can see.
 *
 * Paged through to the end rather than taking the first page, because the page size is not documented
 * as being larger than the roster and a client missing from the picker reads as "Airtable is broken"
 * rather than "there is a second page". The loop is bounded so a malformed cursor cannot spin.
 */
export async function listBases(): Promise<AirtableResult<AirtableBase[]>> {
  const bases: AirtableBase[] = [];
  let offset = "";
  for (let page = 0; page < 20; page += 1) {
    const result = await airtableGet<{ bases?: AirtableBase[]; offset?: string }>(`/meta/bases${offset ? `?offset=${encodeURIComponent(offset)}` : ""}`);
    if (!result.ok) return result;
    for (const base of result.data?.bases ?? []) bases.push({ id: String(base.id ?? ""), name: String(base.name ?? ""), permissionLevel: base.permissionLevel });
    offset = String(result.data?.offset ?? "");
    if (!offset) break;
  }
  return { ok: true, data: bases.filter((base) => base.id) };
}

export async function getBaseTables(baseId: string): Promise<AirtableResult<AirtableTable[]>> {
  const result = await airtableGet<{ tables?: AirtableTable[] }>(`/meta/bases/${encodeURIComponent(baseId)}/tables`);
  if (!result.ok) return result;
  return { ok: true, data: Array.isArray(result.data?.tables) ? result.data.tables : [] };
}

/** The tracker table in a base: by the shared id first, then by name for a base built from scratch. */
export function findTrackerTable(tables: AirtableTable[]): AirtableTable | null {
  const byId = tables.find((table) => table.id === TRACKER_TABLE_ID);
  if (byId) return byId;
  return tables.find((table) => String(table.name ?? "").toLowerCase().includes(TRACKER_NAME_NEEDLE)) ?? null;
}

export type TrackerAudit = {
  baseId: string;
  ready: boolean;
  table: { id: string; name: string; matchedBy: "id" | "name" } | null;
  present: { name: string; id: string; type: string }[];
  missing: { name: string; type: string; why: string }[];
  mistyped: { name: string; id: string; expected: string; actual: string }[];
  statusChoices: string[];
  typeChoices: string[];
};

/**
 * Whether one base's tracker can be written into, and precisely what is wrong when it cannot.
 *
 * Three outcomes, not two, and the middle one is the common one: no tracker table at all, a tracker
 * missing some fields, or a tracker ready to use. A base that is simply not a client base — the lead
 * databases, the automations base — lands in the first, which is also how a mis-mapped base announces
 * itself before anything is written into it.
 *
 * The choice sets are returned rather than checked against an expected list, because they have already
 * drifted per client and there is no correct set to check against. What the writer will need to do is
 * pick from what is actually there, so what is actually there is what this reports.
 */
export async function auditTracker(baseId: string): Promise<AirtableResult<TrackerAudit>> {
  const tables = await getBaseTables(baseId);
  if (!tables.ok) return tables;
  return { ok: true, data: auditTrackerTables(baseId, tables.data) };
}

/** The judgement half of `auditTracker`, kept apart from the fetch so it can be tested against a schema. */
export function auditTrackerTables(baseId: string, tables: AirtableTable[]): TrackerAudit {
  const table = findTrackerTable(tables);
  if (!table) {
    return { baseId, ready: false, table: null, present: [], missing: REQUIRED_TRACKER_FIELDS, mistyped: [], statusChoices: [], typeChoices: [] };
  }
  const fields = Array.isArray(table.fields) ? table.fields : [];
  const byName = new Map(fields.map((field) => [String(field.name ?? "").trim().toLowerCase(), field]));
  const present: TrackerAudit["present"] = [];
  const missing: TrackerAudit["missing"] = [];
  const mistyped: TrackerAudit["mistyped"] = [];
  for (const required of REQUIRED_TRACKER_FIELDS) {
    const field = byName.get(required.name.toLowerCase());
    if (!field) { missing.push(required); continue; }
    if (field.type !== required.type) { mistyped.push({ name: required.name, id: field.id, expected: required.type, actual: field.type }); continue; }
    present.push({ name: required.name, id: field.id, type: field.type });
  }
  const choicesOf = (name: string) =>
    (byName.get(name)?.options?.choices ?? []).map((choice) => String(choice?.name ?? "")).filter(Boolean);
  return {
    baseId,
    ready: missing.length === 0 && mistyped.length === 0,
    table: { id: table.id, name: String(table.name ?? ""), matchedBy: table.id === TRACKER_TABLE_ID ? "id" : "name" },
    present,
    missing,
    mistyped,
    statusChoices: choicesOf("status"),
    typeChoices: choicesOf("type"),
  };
}
