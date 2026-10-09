// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import type { Cell, TableItem, SheetContent } from "./sheets-push";

/**
 * Airtable as a push destination, the same shape as a Google Sheet: a table the team chose, each of its fields
 * mapped to a QC field, and one record per reply, booked meeting or campaign. Written with QC's own Airtable
 * token (AIRTABLE_API_KEY), so a base only has to be shared with QC's Airtable account. Records are found
 * again by a "QC ID" text field QC adds to the table, so a push updates in place and never duplicates.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const API = "https://api.airtable.com/v0";
export const AIRTABLE_QC_ID = "QC ID";

export type AirtableField = { id: string; name: string; type: string };
export type AirtableConfig = {
  baseId: string;
  baseName: string;
  tableId: string;
  tableName: string;
  url: string;
  content?: SheetContent;
  /** The table's fields, in Airtable's order (name and type as last read). */
  fields: AirtableField[];
  /** The QC field each table field holds, by field id ("" = left alone). */
  mapping: Record<string, string>;
  qcIdField?: string;
};

/** Fields QC can write: computed ones (formulas, lookups, created time...) and attachments are left out. */
const WRITABLE = new Set(["singleLineText", "multilineText", "richText", "email", "url", "phoneNumber", "number", "currency", "percent", "rating", "duration", "checkbox", "date", "dateTime", "singleSelect", "multipleSelects"]);
export const writable = (field: AirtableField) => WRITABLE.has(field.type) && field.name !== AIRTABLE_QC_ID;

export class AirtableError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One call with QC's token. Airtable allows 5 calls a second per base, so every call is spaced. */
async function airtable(method: string, path: string, body?: unknown): Promise<Row> {
  const token = process.env.AIRTABLE_API_KEY?.trim();
  if (!token) throw new AirtableError("QC's Airtable token is not set (AIRTABLE_API_KEY on Vercel).", 503);
  await pause(220);
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const raw = await response.text();
  let data: Row = {};
  try { data = raw ? (JSON.parse(raw) as Row) : {}; } catch { data = { message: raw }; }
  if (!response.ok) {
    const detail = (data.error as Row | undefined) ?? {};
    const message = text(detail.message) || text(detail.type) || text(data.error) || `Airtable answered ${response.status}.`;
    if (response.status === 401) throw new AirtableError("Airtable rejected QC's token. Check AIRTABLE_API_KEY.", 401);
    if (response.status === 403 || response.status === 404) throw new AirtableError(`QC's Airtable token can't reach this table (${message}). Share the base with QC's Airtable account, or add it to the token's access list.`, response.status);
    if (response.status === 429) throw new AirtableError("Airtable's rate limit was hit. It clears after 30 seconds; push again then.", 429);
    throw new AirtableError(message, response.status);
  }
  return data;
}

/** The table's fields as Airtable has them now. */
export async function airtableTable(baseId: string, tableId: string): Promise<{ tableName: string; fields: AirtableField[] }> {
  const data = await airtable("GET", `/meta/bases/${encodeURIComponent(baseId)}/tables`);
  const table = (Array.isArray(data.tables) ? (data.tables as Row[]) : []).find((candidate) => text(candidate.id) === tableId || text(candidate.name) === tableId);
  if (!table) throw new AirtableError("That table is gone from the base.", 404);
  const fields = (Array.isArray(table.fields) ? (table.fields as Row[]) : []).map((field) => ({ id: text(field.id), name: text(field.name), type: text(field.type) }));
  return { tableName: text(table.name), fields };
}

/** Adds the QC ID text field when the table doesn't have it yet. */
export async function ensureQcIdField(baseId: string, tableId: string, fields: AirtableField[]): Promise<string> {
  const existing = fields.find((field) => field.name.trim().toLowerCase() === AIRTABLE_QC_ID.toLowerCase());
  if (existing) return existing.id;
  try {
    const made = await airtable("POST", `/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/fields`, { name: AIRTABLE_QC_ID, type: "singleLineText", description: "QC Growth keeps this to update the same record. Leave it as it is." });
    return text(made.id);
  } catch (error) {
    if (error instanceof AirtableError && (error.status === 403 || error.status === 422)) {
      throw new AirtableError(`Add a "Single line text" field named "${AIRTABLE_QC_ID}" to the table (QC's token can't add fields here), then confirm again.`, error.status);
    }
    throw error;
  }
}

/** One value in the shape the field takes. */
function forField(field: AirtableField, value: Cell | undefined): unknown {
  if (value === undefined || value === "") return null;
  const asText = typeof value === "string" ? value : String(value);
  switch (field.type) {
    case "number": case "currency": case "rating": case "duration": {
      const n = Number(asText.replace(/[%,$\s]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "percent": {
      const n = Number(asText.replace(/[%,\s]/g, ""));
      return Number.isFinite(n) ? (asText.includes("%") ? n / 100 : n) : null;
    }
    case "checkbox": return value === true || /^(true|yes|y|1)$/i.test(asText);
    case "date": case "dateTime": {
      const time = Date.parse(asText.includes("T") || asText.length <= 10 ? asText : `${asText.replace(" ", "T")}:00Z`);
      if (Number.isNaN(time)) return null;
      return field.type === "date" ? new Date(time).toISOString().slice(0, 10) : new Date(time).toISOString();
    }
    case "multipleSelects": return asText.split(/\s*,\s*/).filter(Boolean);
    default: return asText.slice(0, 100_000);
  }
}

/**
 * Writes records by QC ID: an existing record is updated, a new one created. Only mapped fields and the QC ID
 * are written, so the team's own fields are left alone. Ten records per call, as Airtable allows.
 */
export async function airtableWriteRows(saved: AirtableConfig, items: TableItem[]): Promise<Map<string, { row: string; created: boolean }>> {
  if (!saved?.baseId || !saved.tableId || !saved.mapping) throw new Error("Map the table's fields first.");
  const { fields } = await airtableTable(saved.baseId, saved.tableId);
  const qcId = fields.find((field) => field.id === saved.qcIdField) ?? fields.find((field) => field.name.trim().toLowerCase() === AIRTABLE_QC_ID.toLowerCase());
  if (!qcId) throw new Error(`The "${AIRTABLE_QC_ID}" field was removed from the table. Click Confirm mapping to add it back.`);
  const mapped = fields.filter((field) => saved.mapping[field.id] && writable(field));

  // Every record's QC ID, to know which already exist.
  const recordById = new Map<string, string>();
  let offset = "";
  for (let page = 0; page < 200; page += 1) {
    const params = new URLSearchParams({ pageSize: "100" });
    params.append("fields[]", qcId.id);
    params.set("returnFieldsByFieldId", "true");
    if (offset) params.set("offset", offset);
    const data = await airtable("GET", `/${encodeURIComponent(saved.baseId)}/${encodeURIComponent(saved.tableId)}?${params}`);
    for (const record of Array.isArray(data.records) ? (data.records as Row[]) : []) {
      const id = text(((record.fields ?? {}) as Row)[qcId.id]);
      if (id && !recordById.has(id)) recordById.set(id, text(record.id));
    }
    offset = text(data.offset);
    if (!offset) break;
  }

  const result = new Map<string, { row: string; created: boolean }>();
  const fieldsOf = (item: TableItem) => {
    const out: Row = { [qcId.id]: item.id };
    for (const field of mapped) out[field.id] = forField(field, item.value(saved.mapping[field.id]));
    return out;
  };
  const updates = items.filter((item) => recordById.has(item.id));
  const creates = items.filter((item) => !recordById.has(item.id));
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    await airtable("PATCH", `/${encodeURIComponent(saved.baseId)}/${encodeURIComponent(saved.tableId)}`, { typecast: true, records: batch.map((item) => ({ id: recordById.get(item.id), fields: fieldsOf(item) })) });
    for (const item of batch) result.set(item.id, { row: recordById.get(item.id)!, created: false });
  }
  for (let i = 0; i < creates.length; i += 10) {
    const batch = creates.slice(i, i + 10);
    const made = await airtable("POST", `/${encodeURIComponent(saved.baseId)}/${encodeURIComponent(saved.tableId)}`, { typecast: true, records: batch.map((item) => ({ fields: fieldsOf(item) })) });
    const records = Array.isArray(made.records) ? (made.records as Row[]) : [];
    batch.forEach((item, index) => result.set(item.id, { row: text(records[index]?.id), created: true }));
  }
  return result;
}

/** A suggested QC field per table field, by name (the QC ID and computed fields never mapped). */
export function airtableSuggest(fields: AirtableField[], catalog: Array<{ key: string; match: RegExp }>): Record<string, string> {
  const used = new Set<string>();
  const mapping: Record<string, string> = {};
  for (const field of fields) {
    if (!writable(field)) continue;
    const normalized = field.name.toLowerCase().replace(/[_\-.:]+/g, " ").replace(/\s+/g, " ").trim();
    const match = catalog.find((candidate) => !used.has(candidate.key) && candidate.match.test(normalized));
    mapping[field.id] = match?.key ?? "";
    if (match) used.add(match.key);
  }
  return mapping;
}
