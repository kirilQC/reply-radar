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
/**
 * Long enough for the biggest base we have, short enough that a genuinely hung call still gives up.
 *
 * This was 8s and it was wrong. `meta/bases/{id}/tables` returns the full schema of *every* table in
 * the base in one response and cannot be narrowed to one table — Bluevia has a Master Outreach Table,
 * a Reply Tracker, call trackers and a per-campaign table for each campaign, which is about 70KB of
 * JSON, and it does not reliably arrive inside eight seconds. The admin screen showed "Airtable did
 * not respond in time" for a base that was fine; the check was just too impatient to see it.
 *
 * The number is a client-base ceiling, not a guess: bases grow a table per campaign, so the response
 * grows over the life of a client and the limit has to have room in it.
 */
const TIMEOUT_MS = 25_000;
/** One retry, for timeouts only — see `airtableGet`. */
const TIMEOUT_RETRIES = 1;

/**
 * The old single tracker, kept only to recognise a base that has not been split yet.
 *
 * Every client base was duplicated from one template, so this id is genuinely shared: it is the
 * `Campaigns & Projects Tracker` in the template, in Willow, in Bluevia and in Cotool. Nothing is
 * written to it any more — it is the "this base still needs splitting" signal.
 */
export const LEGACY_TRACKER_TABLE_ID = "tblb3uziiRyZD2AMi";
const LEGACY_TRACKER_NAME_NEEDLE = "campaigns & projects";

/**
 * ── Why the two new tables are matched by name and not by id ──────────────────────────────────────
 * The legacy tracker could be found by id because every base was duplicated from one template that
 * already contained it. These two tables did not exist when that duplication happened, so each base
 * gets its own ids when they are added — Bluevia's `Campaigns` is `tblrq38rkLIPujZUs` and no other
 * base will ever share that. An id is only a shared handle when a shared ancestor handed it out.
 *
 * So the name is the contract, and the name is therefore load-bearing: renaming `Campaigns` in a
 * client base disconnects the brief from it. That is deliberately visible — the audit says the table
 * is missing rather than writing somewhere unexpected.
 */
export const CAMPAIGNS_TABLE_NAME = "Campaign Tracker";
export const ACTION_ITEMS_TABLE_NAME = "Project Tracker";

/**
 * The fields the brief needs in order to write an action item.
 *
 * Every one of these traces to something the brief already produces. `Owner` is text rather than a
 * collaborator because the brief's owners are Slack mentions and not all of them are people — "QC
 * Campaign Approval and Launch" is a group, and guessing a collaborator from a name would put a task
 * on whoever shares a first name. `Assignee` stays a collaborator for humans to set by hand.
 *
 * `Brief Key` and `Raised by Brief` are what make a re-run safe: the key finds the row this item
 * already has, and the checkbox marks the rows the brief is allowed to touch. Without both, three
 * briefs about one unfinished task make three rows.
 */
export const REQUIRED_ACTION_ITEM_FIELDS: { name: string; type: string; why: string }[] = [
  { name: "Title", type: "singleLineText", why: "the action item itself" },
  { name: "Type", type: "singleSelect", why: "action item, project or bottleneck" },
  { name: "Status", type: "singleSelect", why: "so a finished item can be closed" },
  { name: "Owner", type: "singleLineText", why: "who owes it, as the brief named them" },
  { name: "Detail", type: "multilineText", why: "the evidence for raising it" },
  { name: "Source", type: "singleSelect", why: "internal channel, client channel or call" },
  { name: "First Raised", type: "date", why: "what ages an item" },
  { name: "Brief Key", type: "singleLineText", why: "so a re-run updates instead of duplicating" },
  { name: "Last Seen", type: "date", why: "the last brief that still considered it open" },
  { name: "Raised by Brief", type: "checkbox", why: "so the brief never edits a row you typed" },
];

/**
 * What the brief needs in order to move a campaign through its life and leave the final figures behind.
 *
 * The row is not the brief's to begin with — the approval process creates it and marks it sent for
 * approval — so the brief writes only these: the status, the figures, and the two dates that say when
 * it last looked and when the campaign ran out. `Title`, `Owner` and `Notes` are somebody's writing and
 * are never overwritten.
 *
 * The rates are formulas in Airtable rather than fields here, because a stored rate is a figure that
 * can disagree with the two numbers above it.
 */
export const REQUIRED_CAMPAIGN_FIELDS: { name: string; type: string; why: string }[] = [
  { name: "Title", type: "singleLineText", why: "the campaign name" },
  { name: "Campaign Code", type: "singleLineText", why: "joins the row to its lead table" },
  { name: "Status", type: "singleSelect", why: "where it is in its life" },
  { name: "Leads Sent", type: "number", why: "the headline figure when it finishes" },
  { name: "Accepted", type: "number", why: "the other half of the acceptance rate" },
  { name: "Replies", type: "number", why: "what the campaign was for" },
  { name: "Pending Leads", type: "number", why: "zero on a live campaign is what finishes it" },
  { name: "Days Left", type: "number", why: "the runway warning, in the tracker as well as the brief" },
  { name: "Senders", type: "singleLineText", why: "sender names, never ids" },
  { name: "Finished On", type: "date", why: "the day the figures became final" },
  { name: "Last Synced", type: "date", why: "a date that stopped moving means the brief lost the campaign" },
];

export type AirtableBase = { id: string; name: string; permissionLevel?: string };

export type AirtableField = { id: string; name: string; type: string; options?: { choices?: { id: string; name: string }[] } };

export type AirtableTable = { id: string; name: string; primaryFieldId?: string; fields?: AirtableField[] };

export type AirtableResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export function isAirtableConfigured() {
  return Boolean(process.env.AIRTABLE_API_KEY);
}

/**
 * One GET, with a single retry when — and only when — it timed out.
 *
 * The retry is narrow on purpose. A 429 must never be retried: Airtable's rate limit locks the token
 * out of the base for a full thirty seconds, so a second attempt is guaranteed to fail and to spend
 * somebody's request budget doing it. A 401 or 403 is a token setting and will fail identically
 * forever. A timeout is the one failure here that is plausibly luck, and a large schema arriving
 * slowly once is exactly the case that made this necessary.
 */
async function airtableGet<T>(path: string, attempt = 0): Promise<AirtableResult<T>> {
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
    if (aborted && attempt < TIMEOUT_RETRIES) {
      clearTimeout(timer);
      return airtableGet<T>(path, attempt + 1);
    }
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

/**
 * One write, with no retry at all.
 *
 * Deliberately unlike `airtableGet`. A GET that times out can be repeated because nothing happened; a
 * POST that times out may well have landed, and repeating it is how one action item becomes two rows
 * in somebody's tracker. So a write that does not come back is reported as a write whose outcome is
 * unknown, and the next brief reconciles it — that is what `Brief Key` is for.
 */
async function airtableSend<T>(method: "POST" | "PATCH" | "DELETE", path: string, payload?: unknown): Promise<AirtableResult<T>> {
  const token = process.env.AIRTABLE_API_KEY;
  if (!token) return { ok: false, error: "No Airtable token is set. Add AIRTABLE_API_KEY.", status: 503 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) {
      const detail = (body as { error?: { message?: string; type?: string } })?.error;
      const message =
        response.status === 401 ? "Airtable rejected the token. Check AIRTABLE_API_KEY."
          : response.status === 403 ? "The token cannot write to this base. It needs data.records:write."
            : response.status === 429 ? "Airtable rate limit hit. It clears after 30 seconds."
              : String(detail?.message || detail?.type || `Airtable returned ${response.status}.`);
      return { ok: false, error: message, status: response.status };
    }
    return { ok: true, data: body as T };
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    return { ok: false, error: aborted ? "Airtable did not answer the write in time, so it is not known whether it landed." : "Airtable could not be reached.", status: 504 };
  } finally {
    clearTimeout(timer);
  }
}

export type AirtableRecord = { id: string; createdTime?: string; fields: Record<string, unknown> };

/** Airtable's own ceiling: ten records per create, update or delete request. Not a tuning knob. */
const WRITE_BATCH = 10;

/**
 * Every record in one table.
 *
 * Paged to the end, because a tracker the brief only half read is a tracker it will duplicate rows
 * into. The loop is bounded at 5,000 rows: a tracker that large is not a tracker, and spinning through
 * it inside a request nobody is watching is worse than stopping.
 */
export async function listRecords(baseId: string, tableId: string): Promise<AirtableResult<AirtableRecord[]>> {
  const records: AirtableRecord[] = [];
  let offset = "";
  for (let page = 0; page < 50; page += 1) {
    const query = `pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`;
    const result = await airtableGet<{ records?: AirtableRecord[]; offset?: string }>(`/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?${query}`);
    if (!result.ok) return result;
    for (const record of result.data?.records ?? []) records.push({ id: String(record.id ?? ""), createdTime: record.createdTime, fields: record.fields ?? {} });
    offset = String(result.data?.offset ?? "");
    if (!offset) break;
  }
  return { ok: true, data: records.filter((record) => record.id) };
}

export async function createRecords(baseId: string, tableId: string, rows: Record<string, unknown>[]): Promise<AirtableResult<AirtableRecord[]>> {
  return writeInBatches(rows, WRITE_BATCH, async (batch) => {
    const result = await airtableSend<{ records?: AirtableRecord[] }>("POST", `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`, { records: batch.map((fields) => ({ fields })) });
    return result.ok ? { ok: true, data: result.data?.records ?? [] } : result;
  });
}

export async function updateRecords(baseId: string, tableId: string, rows: { id: string; fields: Record<string, unknown> }[]): Promise<AirtableResult<AirtableRecord[]>> {
  return writeInBatches(rows, WRITE_BATCH, async (batch) => {
    const result = await airtableSend<{ records?: AirtableRecord[] }>("PATCH", `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`, { records: batch });
    return result.ok ? { ok: true, data: result.data?.records ?? [] } : result;
  });
}

export async function deleteRecords(baseId: string, tableId: string, ids: string[]): Promise<AirtableResult<string[]>> {
  return writeInBatches(ids, WRITE_BATCH, async (batch) => {
    const query = batch.map((id) => `records[]=${encodeURIComponent(id)}`).join("&");
    const result = await airtableSend<{ records?: { id: string }[] }>("DELETE", `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?${query}`);
    return result.ok ? { ok: true, data: (result.data?.records ?? []).map((record) => String(record.id ?? "")) } : result;
  });
}

/**
 * Batches run one after another, never in parallel.
 *
 * Airtable allows five requests a second per base and answers the sixth with a thirty second lockout,
 * which would take the rest of the sync down with it. Sequential is not slow here: a tracker is tens of
 * rows, so this is two or three requests.
 *
 * A failed batch stops the run and returns what landed before it. Carrying on would mean the caller
 * cannot tell a partial write from a whole one, and half a tracker updated silently is exactly the
 * quiet wrongness this file exists to avoid.
 */
async function writeInBatches<In, Out>(items: In[], size: number, send: (batch: In[]) => Promise<AirtableResult<Out[]>>): Promise<AirtableResult<Out[]>> {
  const done: Out[] = [];
  for (let index = 0; index < items.length; index += size) {
    const result = await send(items.slice(index, index + size));
    if (!result.ok) return result;
    done.push(...result.data);
  }
  return { ok: true, data: done };
}

/** Names are compared flattened, so a stray double space or a capital does not read as a missing table. */
const flatten = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** A table by its exact name. See `CAMPAIGNS_TABLE_NAME` for why these two are not found by id. */
export function findTableByName(tables: AirtableTable[], name: string): AirtableTable | null {
  return tables.find((table) => flatten(table.name) === flatten(name)) ?? null;
}

/** The pre-split tracker, if this base still has one. Nothing is written to it. */
export function findLegacyTracker(tables: AirtableTable[]): AirtableTable | null {
  const byId = tables.find((table) => table.id === LEGACY_TRACKER_TABLE_ID);
  if (byId) return byId;
  return tables.find((table) => flatten(table.name).includes(LEGACY_TRACKER_NAME_NEEDLE)) ?? null;
}

export type TableAudit = {
  name: string;
  table: { id: string; name: string } | null;
  present: { name: string; id: string; type: string }[];
  missing: { name: string; type: string; why: string }[];
  mistyped: { name: string; id: string; expected: string; actual: string }[];
  choices: Record<string, string[]>;
};

export type TrackerAudit = {
  baseId: string;
  ready: boolean;
  campaigns: TableAudit;
  actionItems: TableAudit;
  /** True when the base still has the old combined tracker and has not been split. */
  needsSplit: boolean;
  legacyTable: { id: string; name: string } | null;
};

/**
 * Whether one base's two tracker tables can be written into, and precisely what is wrong when they
 * cannot.
 *
 * The interesting outcome is the third one. A base can fail this three ways: it is not a client base
 * at all (neither table, no legacy tracker), it is a client base that has not been split yet (legacy
 * tracker present, new tables absent — `needsSplit`), or it has the tables but somebody has changed a
 * field. Collapsing those into "not ready" would send you looking for a missing column in a base whose
 * real problem is that it was never set up.
 *
 * Choice sets are reported, not validated. They have already drifted per client — Cotool has no
 * `Completed`, Bluevia had both `Completed` and `Done` plus an option with an empty name — so there is
 * no correct set to check against, and the writer's job is to pick from whatever is actually there.
 */
export async function auditTracker(baseId: string): Promise<AirtableResult<TrackerAudit>> {
  const tables = await getBaseTables(baseId);
  if (!tables.ok) return tables;
  return { ok: true, data: auditTrackerTables(baseId, tables.data) };
}

function auditOneTable(tables: AirtableTable[], name: string, required: { name: string; type: string; why: string }[]): TableAudit {
  const table = findTableByName(tables, name);
  if (!table) return { name, table: null, present: [], missing: required, mistyped: [], choices: {} };
  const fields = Array.isArray(table.fields) ? table.fields : [];
  const byName = new Map(fields.map((field) => [flatten(field.name), field]));
  const present: TableAudit["present"] = [];
  const missing: TableAudit["missing"] = [];
  const mistyped: TableAudit["mistyped"] = [];
  for (const want of required) {
    const field = byName.get(flatten(want.name));
    if (!field) { missing.push(want); continue; }
    if (field.type !== want.type) { mistyped.push({ name: want.name, id: field.id, expected: want.type, actual: field.type }); continue; }
    present.push({ name: want.name, id: field.id, type: field.type });
  }
  const choices: Record<string, string[]> = {};
  for (const field of fields) {
    const list = (field.options?.choices ?? []).map((choice) => String(choice?.name ?? "")).filter(Boolean);
    if (list.length) choices[String(field.name ?? "")] = list;
  }
  return { name, table: { id: table.id, name: String(table.name ?? "") }, present, missing, mistyped, choices };
}

/** The judgement half of `auditTracker`, kept apart from the fetch so it can be tested against a schema. */
export function auditTrackerTables(baseId: string, tables: AirtableTable[]): TrackerAudit {
  const campaigns = auditOneTable(tables, CAMPAIGNS_TABLE_NAME, REQUIRED_CAMPAIGN_FIELDS);
  const actionItems = auditOneTable(tables, ACTION_ITEMS_TABLE_NAME, REQUIRED_ACTION_ITEM_FIELDS);
  const legacy = findLegacyTracker(tables);
  const clean = (audit: TableAudit) => Boolean(audit.table) && !audit.missing.length && !audit.mistyped.length;
  return {
    baseId,
    ready: clean(campaigns) && clean(actionItems),
    campaigns,
    actionItems,
    // Only worth saying when the new tables are genuinely absent. A base mid-migration, with both the
    // old tracker and the new tables, is not asking to be split again.
    needsSplit: Boolean(legacy) && !campaigns.table && !actionItems.table,
    legacyTable: legacy ? { id: legacy.id, name: String(legacy.name ?? "") } : null,
  };
}

/** Every option on one single select, as the base spells them. */
export function choicesFor(table: AirtableTable | null, fieldName: string): string[] {
  const field = (table?.fields ?? []).find((candidate) => flatten(candidate.name) === flatten(fieldName));
  return (field?.options?.choices ?? []).map((choice) => String(choice?.name ?? "")).filter(Boolean);
}
