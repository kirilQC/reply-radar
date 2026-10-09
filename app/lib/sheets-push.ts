// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { createSign } from "node:crypto";
import { conversationText, type Destination, type ReplyRecord } from "./crm-push";
import { googleAccount, googleUserToken } from "./google-user";
import { createHash } from "node:crypto";
import { rows, type Config } from "./crm-push";
import { dealFacts } from "./hubspot-deals";
import { cleanMeeting, internalMeeting, personKey } from "./meetings-deals-run";

/**
 * Replies into a Google Sheet the team made, with the headers they want. QC Command writes as one Google
 * service account (GOOGLE_SERVICE_ACCOUNT_JSON on Vercel); a sheet is shared with that account's email as
 * Editor, nothing else. The header row is read, each header is mapped to a QC field (suggested, then
 * confirmed), and every lead is one row, found again by a "QC ID" column QC adds at the end, so a new reply
 * updates the lead's row instead of adding another.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

// ── Auth: a service account JWT, exchanged for an access token ────────────────────────────────────

type ServiceAccount = { client_email: string; private_key: string };

/** QC Command's Google robot (not secret): used when the variable holds only the private key. */
const QC_ROBOT_EMAIL = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "qc-growth@adept-region-511117-t8.iam.gserviceaccount.com").trim();

/** Reads the key file's JSON, or just its private key (the whole file is not always what gets pasted). */
export function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount> | string;
    if (typeof parsed === "string" && parsed.includes("PRIVATE KEY")) return { client_email: QC_ROBOT_EMAIL, private_key: parsed.replace(/\\n/g, "\n") };
    if (typeof parsed === "object" && parsed?.client_email && parsed.private_key) return { client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, "\n") };
  } catch {
    // not JSON: a bare PEM key, possibly with escaped newlines
  }
  if (raw.includes("BEGIN PRIVATE KEY")) {
    const pem = raw.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
    return { client_email: QC_ROBOT_EMAIL, private_key: pem };
  }
  return null;
}

/** Whether the key is there and readable, never its contents: for the panel's setup message. */
export function serviceAccountStatus(): { present: boolean; parses: boolean; hasEmail: boolean; hasKey: boolean; length: number; signIn?: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() ?? "";
  let parsed: Partial<ServiceAccount> | null = null;
  try { parsed = raw ? (JSON.parse(raw) as Partial<ServiceAccount>) : null; } catch { parsed = null; }
  const account = serviceAccount();
  return { present: Boolean(raw), parses: Boolean(parsed), hasEmail: Boolean(account?.client_email), hasKey: Boolean(account?.private_key), length: raw.length };
}

let cached: { token: string; until: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached && cached.until - Date.now() > 60_000) return cached.token;
  const account = serviceAccount();
  if (!account) throw new Error("QC Command's Google account is not set up (GOOGLE_SERVICE_ACCOUNT_JSON on Vercel).");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key).toString("base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) throw new Error(`Google sign-in failed: ${text(data.error_description) || text(data.error) || response.status}`);
  cached = { token: text(data.access_token), until: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cached.token;
}

export class SheetsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** QC's own Google sign-in (admin@qcgrowth.com) when connected, else the service account. */
async function sheetsToken(): Promise<string> {
  return (await googleUserToken().catch(() => null)) ?? accessToken();
}

/** The address a sheet has to be editable by: the signed-in Google account, else the service account. */
export async function writerEmail(): Promise<string | null> {
  return (await googleAccount().catch(() => null))?.email ?? serviceAccount()?.client_email ?? null;
}

async function sheets(method: string, path: string, body?: unknown, attempt = 0): Promise<Row> {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await sheetsToken()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    return sheets(method, path, body, attempt + 1);
  }
  const data = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) {
    const message = text((data.error as Row | undefined)?.message);
    if (response.status === 403 || response.status === 404) {
      throw new SheetsError(`QC Command can't open that sheet. Make sure ${(await writerEmail()) ?? "QC Command's Google account"} can edit it.`, response.status);
    }
    throw new SheetsError(message || `Google Sheets answered ${response.status}.`, response.status);
  }
  return data;
}

// ── The sheet and its headers ───────────────────────────────────────────────────────────────────

export function parseSheetUrl(url: string): { spreadsheetId: string; gid: string | null } | null {
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url)?.[1];
  if (!id) return null;
  const gid = /[#&?]gid=(\d+)/.exec(url)?.[1] ?? null;
  return { spreadsheetId: id, gid };
}

const quote = (title: string) => `'${title.replace(/'/g, "''")}'`;

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    letters = String.fromCharCode(65 + r) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export async function sheetsConnect(url: string): Promise<{ spreadsheetId: string; title: string; tab: string; headers: string[] }> {
  const parsed = parseSheetUrl(url);
  if (!parsed) throw new Error("That doesn't look like a Google Sheets link.");
  const meta = await sheets("GET", `${parsed.spreadsheetId}?fields=properties.title,sheets.properties`);
  const tabs = (Array.isArray(meta.sheets) ? meta.sheets : []).map((sheet) => (sheet as Row).properties as Row);
  const tab = tabs.find((properties) => parsed.gid !== null && String(properties.sheetId) === parsed.gid) ?? tabs[0];
  if (!tab) throw new Error("That spreadsheet has no tabs.");
  const tabTitle = text(tab.title);
  const header = await sheets("GET", `${parsed.spreadsheetId}/values/${encodeURIComponent(`${quote(tabTitle)}!1:1`)}`);
  const headers = ((Array.isArray(header.values) ? header.values[0] : []) as unknown[]).map((cell) => text(cell));
  return { spreadsheetId: parsed.spreadsheetId, title: text((meta.properties as Row | undefined)?.title), tab: tabTitle, headers };
}

// ── The QC fields a header can map to ─────────────────────────────────────────────────────────────

const when = (value: string) => (value ? new Date(value).toISOString().replace("T", " ").slice(0, 16) : "");

export const SHEET_FIELDS: Array<{ key: string; label: string; match: RegExp; value: (record: ReplyRecord) => string | number | boolean }> = [
  { key: "name", label: "Full name", match: /^(full ?)?name$|^lead( name)?$|^contact( name)?$|^person$/, value: (r) => r.name },
  { key: "first_name", label: "First name", match: /^first( ?name)?$/, value: (r) => r.firstName },
  { key: "last_name", label: "Last name", match: /^(last|sur) ?name$/, value: (r) => r.lastName },
  { key: "email", label: "Email", match: /e-?mail/, value: (r) => r.email },
  { key: "title", label: "Job title", match: /title|role|position/, value: (r) => r.title },
  { key: "company", label: "Company", match: /^company( name)?$|^organi[sz]ation$|^account$/, value: (r) => r.company },
  { key: "company_domain", label: "Company domain", match: /domain|website/, value: (r) => r.domain },
  { key: "linkedin", label: "LinkedIn", match: /^(person(al)? |lead |contact )?linked ?in( url| profile)?$/, value: (r) => r.linkedinCanonical || r.linkedinUrl },
  { key: "company_linkedin", label: "Company LinkedIn", match: /company linked ?in/, value: (r) => r.companyLinkedinUrl },
  { key: "campaign", label: "Campaign", match: /campaign/, value: (r) => r.campaign },
  { key: "sender", label: "Sender", match: /sender|sent by|from/, value: (r) => r.sender },
  { key: "platform", label: "Outreach platform", match: /platform|tool|source/, value: (r) => r.platform },
  { key: "channel", label: "Channel", match: /channel/, value: (r) => (r.channel === "email" ? "Email" : "LinkedIn") },
  { key: "sentiment", label: "Reply sentiment", match: /sentiment|status|intent/, value: (r) => (r.sentiment ? r.sentiment[0].toUpperCase() + r.sentiment.slice(1) : "") },
  { key: "first_reply", label: "First reply", match: /first repl/, value: (r) => when(r.firstReplyAt) },
  { key: "last_reply", label: "Last reply", match: /last repl|replied (at|on)|reply date|date/, value: (r) => when(r.lastReplyAt) },
  { key: "reply_count", label: "Reply count", match: /repl(y|ies) ?(count|#)|# ?repl|number of repl/, value: (r) => r.replyCount },
  { key: "booked_meeting", label: "Booked meeting", match: /booked|meeting/, value: (r) => r.bookedMeeting },
  { key: "latest_reply", label: "Latest reply", match: /latest repl|last message|^reply$|^message$|response/, value: (r) => r.latestReply.slice(0, 5000) },
  { key: "conversation", label: "Full conversation", match: /conversation|thread|history|transcript/, value: (r) => conversationText(r, 45_000, "plain") },
];

const QC_ID_HEADER = "QC ID";

/** A suggested field per header (or "" to leave a column alone), the QC ID column never mapped. */
export function suggestMapping(headers: string[], content: SheetContent = "replies"): string[] {
  const catalog = fieldsFor(content);
  const used = new Set<string>();
  return headers.map((header) => {
    const normalized = header.toLowerCase().replace(/[_\-.:]+/g, " ").replace(/\s+/g, " ").trim();
    if (!normalized || normalized === QC_ID_HEADER.toLowerCase()) return "";
    const field = catalog.find((candidate) => !used.has(candidate.key) && candidate.match.test(normalized));
    if (!field) return "";
    used.add(field.key);
    return field.key;
  });
}

export type SheetConfig = { spreadsheetId: string; tab: string; headers: string[]; mapping: string[]; qcIdColumn: number; content?: SheetContent };

/** Adds the QC ID header at the end of the header row when it is not there yet. */
export async function ensureQcIdColumn(spreadsheetId: string, tab: string, headers: string[]): Promise<{ headers: string[]; qcIdColumn: number }> {
  const existing = headers.findIndex((header) => header.trim().toLowerCase() === QC_ID_HEADER.toLowerCase());
  if (existing >= 0) return { headers, qcIdColumn: existing };
  const index = headers.length;
  await sheets("PUT", `${spreadsheetId}/values/${encodeURIComponent(`${quote(tab)}!${columnLetter(index)}1`)}?valueInputOption=RAW`, { values: [[QC_ID_HEADER]] });
  return { headers: [...headers, QC_ID_HEADER], qcIdColumn: index };
}

/**
 * The sheet as it is now: row 1 read again, each column's field found by its header name (the mapping is
 * confirmed per header, not per position), so columns can be reordered or inserted after connecting.
 */
async function currentLayout(config: SheetConfig): Promise<SheetConfig> {
  const header = await sheets("GET", `${config.spreadsheetId}/values/${encodeURIComponent(`${quote(config.tab)}!1:1`)}`);
  const headers = ((Array.isArray(header.values) ? header.values[0] : []) as unknown[]).map((cell) => text(cell));
  const byName = new Map(config.headers.map((name, index) => [name.trim().toLowerCase(), config.mapping[index] ?? ""]));
  const qcIdColumn = headers.findIndex((name) => name.trim().toLowerCase() === QC_ID_HEADER.toLowerCase());
  if (qcIdColumn < 0) throw new Error(`The "${QC_ID_HEADER}" column was removed from the sheet. Click Confirm mapping to add it back.`);
  const mapping = headers.map((name, index) => (index === qcIdColumn ? "" : byName.get(name.trim().toLowerCase()) ?? ""));
  return { ...config, headers, mapping, qcIdColumn };
}

// ── Push: a batch of records, one row each ───────────────────────────────────────────────────────

type Cell = string | number | boolean;

/**
 * Writes rows by QC ID: an existing row is updated in place, a new one appended. Only mapped columns and the
 * QC ID are written, so the team's own columns between them are left untouched. Returns the row per id.
 */
async function writeRows(saved: SheetConfig, items: Array<{ id: string; value: (key: string) => Cell | undefined }>): Promise<Map<string, { row: number; created: boolean }>> {
  if (!saved?.spreadsheetId || !Array.isArray(saved.mapping)) throw new Error("Map the sheet's columns first.");
  const { spreadsheetId, tab, mapping, qcIdColumn } = await currentLayout(saved);
  const letter = columnLetter(qcIdColumn);
  const idColumn = await sheets("GET", `${spreadsheetId}/values/${encodeURIComponent(`${quote(tab)}!${letter}:${letter}`)}`);
  const rowById = new Map<string, number>();
  (Array.isArray(idColumn.values) ? idColumn.values : []).forEach((cells, index) => {
    const id = text(Array.isArray(cells) ? cells[0] : "");
    if (id && index > 0) rowById.set(id, index + 1);
  });
  let nextRow = Math.max(1, (Array.isArray(idColumn.values) ? idColumn.values.length : 1)) + 1;
  const data: Array<{ range: string; values: Cell[][] }> = [];
  const result = new Map<string, { row: number; created: boolean }>();
  for (const item of items) {
    const existing = rowById.get(item.id);
    const row = existing ?? nextRow++;
    rowById.set(item.id, row);
    result.set(item.id, { row, created: !existing });
    mapping.forEach((key, index) => {
      if (!key) return;
      data.push({ range: `${quote(tab)}!${columnLetter(index)}${row}`, values: [[item.value(key) ?? ""]] });
    });
    data.push({ range: `${quote(tab)}!${letter}${row}`, values: [[item.id]] });
  }
  if (data.length) await sheets("POST", `${spreadsheetId}/values:batchUpdate`, { valueInputOption: "USER_ENTERED", data });
  return result;
}

/** Replies: one row per conversation. */
export async function sheetsPushBatch(destination: Destination, records: ReplyRecord[]): Promise<Map<string, { row: number; created: boolean }>> {
  return writeRows(destination.config as unknown as SheetConfig, records.map((record) => ({
    id: record.conversationId,
    value: (key) => SHEET_FIELDS.find((field) => field.key === key)?.value(record),
  })));
}

// ── Booked meetings: one row per person ─────────────────────────────────────────────────────────

type MeetingFacts = { meeting: Row; facts: Awaited<ReturnType<typeof dealFacts>> };
const f = (facts: MeetingFacts, key: string) => facts.facts.fields[key] as Cell | undefined;

export const MEETING_SHEET_FIELDS: Array<{ key: string; label: string; match: RegExp; value: (row: MeetingFacts) => Cell | undefined }> = [
  { key: "company", label: "Company", match: /^company( name)?$|^organi[sz]ation$|^account$/, value: (r) => text(r.meeting.company_name) || r.facts.reply?.company || "" },
  { key: "name", label: "Full name", match: /^(full ?)?name$|^lead( name)?$|^contact( name)?$|^person$|^attendee|^invitee/, value: (r) => text(r.meeting.invitee_name) },
  { key: "first_name", label: "First name", match: /^first( ?name)?$/, value: (r) => text(r.meeting.invitee_name).split(/\s+/)[0] ?? "" },
  { key: "last_name", label: "Last name", match: /^(last|sur) ?name$/, value: (r) => text(r.meeting.invitee_name).split(/\s+/).slice(1).join(" ") },
  { key: "email", label: "Email", match: /e-?mail/, value: (r) => f(r, "qc_lead_email") },
  { key: "title", label: "Job title", match: /title|role|position/, value: (r) => f(r, "qc_lead_title") },
  { key: "linkedin", label: "LinkedIn", match: /^(person(al)? |lead |contact )?linked ?in( url| profile)?$/, value: (r) => f(r, "qc_lead_linkedin") },
  { key: "company_domain", label: "Company domain", match: /domain|website/, value: (r) => f(r, "qc_company_domain") },
  { key: "company_linkedin", label: "Company LinkedIn", match: /company linked ?in/, value: (r) => f(r, "qc_company_linkedin") },
  { key: "industry", label: "Industry", match: /industry|sector/, value: (r) => f(r, "qc_company_industry") },
  { key: "size", label: "Company size", match: /size|headcount|employees/, value: (r) => f(r, "qc_company_size") },
  { key: "location", label: "Location", match: /location|city|country|region/, value: (r) => f(r, "qc_company_location") },
  { key: "meeting_date", label: "Meeting date", match: /meeting (date|time)|^date$|^when$|scheduled( for)?|call (date|time)/, value: (r) => when(text(r.meeting.meeting_at)) || text(r.meeting.when_text) },
  { key: "status", label: "Meeting status", match: /status/, value: (r) => ({ scheduled: "Scheduled", rescheduled: "Rescheduled", canceled: "Canceled", completed: "Completed", no_show: "No-show" } as Record<string, string>)[r.facts.status] ?? r.facts.status },
  { key: "host", label: "Meeting host", match: /host|with|owner|rep|ae\b/, value: (r) => f(r, "qc_meeting_host") },
  { key: "booked_at", label: "Booked at", match: /booked( at| on)?|created/, value: (r) => when(text(r.meeting.created_at)) },
  { key: "campaign", label: "Campaign", match: /campaign/, value: (r) => f(r, "qc_campaign") },
  { key: "sender", label: "Sender", match: /sender|sent by/, value: (r) => f(r, "qc_sender") },
  { key: "platform", label: "Outreach platform", match: /platform|tool|source/, value: (r) => f(r, "qc_outreach_platform") },
  { key: "sentiment", label: "Reply sentiment", match: /sentiment|intent/, value: (r) => f(r, "qc_reply_sentiment") },
  { key: "latest_reply", label: "Latest reply", match: /latest repl|last message|^reply$|^message$|response/, value: (r) => f(r, "qc_latest_reply") },
  { key: "conversation", label: "Full conversation", match: /conversation|thread|history|transcript/, value: (r) => f(r, "qc_conversation") },
  { key: "pre_call_brief", label: "Pre-call brief", match: /brief|notes|summary|tl ?dr|prep/, value: (r) => f(r, "qc_pre_call_brief") },
];

export type SheetContent = "replies" | "meetings";
export const fieldsFor = (content: SheetContent | undefined) => (content === "meetings" ? MEETING_SHEET_FIELDS : SHEET_FIELDS);

/** Booked meetings into a meetings sheet: cleaned, QC's own tests left out, one row per person (their latest booking). */
export async function sheetsPushMeetings(config: Config, destination: Destination, opts: { since?: string } = {}): Promise<{ pushed: number; created: number; updated: number }> {
  const meetings = await rows(config, `rr_meetings?select=*&workspace_id=eq.${encodeURIComponent(destination.workspace_id)}&order=meeting_at.asc.nullsfirst,created_at.asc&limit=1000`);
  const latest = new Map<string, Row>();
  const changed = new Set<string>();
  for (const raw of meetings) {
    const meeting = cleanMeeting(raw);
    if (internalMeeting(meeting)) continue;
    const key = personKey(meeting);
    const previous = latest.get(key);
    // A canceled older booking never overwrites a newer live one.
    if (previous && /cancel/i.test(text(meeting.status)) && !/cancel/i.test(text(previous.status))) continue;
    latest.set(key, meeting);
    if (!opts.since || text(raw.updated_at) >= opts.since) changed.add(key);
  }
  const due = [...latest.entries()].filter(([key]) => changed.has(key));
  if (!due.length) return { pushed: 0, created: 0, updated: 0 };
  const items: Array<{ id: string; value: (key: string) => Cell | undefined }> = [];
  for (const [key, meeting] of due) {
    const facts: MeetingFacts = { meeting, facts: await dealFacts(config, destination.workspace_id, meeting) };
    items.push({ id: `meeting:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`, value: (field) => MEETING_SHEET_FIELDS.find((candidate) => candidate.key === field)?.value(facts) });
  }
  const written = await writeRows(destination.config as unknown as SheetConfig, items);
  const created = [...written.values()].filter((entry) => entry.created).length;
  return { pushed: written.size, created, updated: written.size - created };
}

// ── Formatting: QC's house style, applied to whole columns so new rows inherit it ───────────────

const LEFT_WRAPPED = new Set(["latest_reply", "conversation", "pre_call_brief"]);
const LEFT = new Set(["name", "first_name", "last_name", "email", "linkedin", "company_linkedin", "company"]);
const WIDTH: Record<string, number> = { pre_call_brief: 460, latest_reply: 420, conversation: 520, linkedin: 260, company_linkedin: 260, campaign: 300, title: 260, email: 220 };
const grey = (level: number) => ({ red: level, green: level, blue: level });

/**
 * Header row bold, grey, centered and frozen with filter buttons; alternating row colors; short fields
 * centered, the reply and conversation left-aligned and wrapped, wider columns where text runs long, and
 * the QC ID column hidden. Existing banding or a filter on the sheet is kept, not duplicated.
 */
export async function sheetsFormat(saved: SheetConfig): Promise<void> {
  const config = await currentLayout(saved);
  const meta = await sheets("GET", `${config.spreadsheetId}?fields=sheets(properties(sheetId,title),bandedRanges(bandedRangeId),basicFilter)`);
  const tab = (Array.isArray(meta.sheets) ? meta.sheets : []).map((sheet) => sheet as Row).find((sheet) => text(((sheet.properties as Row) ?? {}).title) === config.tab);
  if (!tab) throw new Error(`The tab "${config.tab}" is gone from that sheet.`);
  const sheetId = Number(((tab.properties as Row) ?? {}).sheetId);
  const columns = Math.max(config.headers.length, config.qcIdColumn + 1);
  const requests: Row[] = [];
  const column = (index: number) => ({ sheetId, startColumnIndex: index, endColumnIndex: index + 1, startRowIndex: 1 });

  requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columns },
      cell: { userEnteredFormat: { backgroundColor: grey(0.8), horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP", textFormat: { bold: true } } },
      fields: "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat.bold)",
    },
  });
  config.mapping.forEach((key, index) => {
    if (index === config.qcIdColumn) return;
    const wrapped = LEFT_WRAPPED.has(key);
    requests.push({
      repeatCell: {
        range: column(index),
        cell: { userEnteredFormat: { horizontalAlignment: wrapped || LEFT.has(key) ? "LEFT" : "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: wrapped ? "WRAP" : "CLIP" } },
        fields: "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)",
      },
    });
    if (WIDTH[key]) requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 }, properties: { pixelSize: WIDTH[key] }, fields: "pixelSize" } });
  });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: config.qcIdColumn, endIndex: config.qcIdColumn + 1 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } });
  if (!Array.isArray(tab.bandedRanges) || !tab.bandedRanges.length) {
    requests.push({ addBanding: { bandedRange: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: columns }, rowProperties: { headerColor: grey(0.8), firstBandColor: grey(1), secondBandColor: grey(0.95) } } } });
  }
  if (!tab.basicFilter) requests.push({ setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: columns } } } });
  await sheets("POST", `${config.spreadsheetId}:batchUpdate`, { requests });
}
