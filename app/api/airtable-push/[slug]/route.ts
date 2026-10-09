// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { presentDestination, rest, rows, saveDestination, withPushLock, type Destination } from "../../../lib/crm-push";
import { pushPass, recordKey } from "../../../lib/crm-push-run";
import { listBases, getBaseTables, isAirtableConfigured } from "../../../lib/airtable";
import { AIRTABLE_QC_ID, addMissingAirtableFields, createQcTable, suggestBase, suggestTable, airtableSuggest, airtableTable, ensureQcIdField, writable, type AirtableConfig, type AirtableField } from "../../../lib/airtable-push";
import { contentOf, fieldsFor, type SheetContent } from "../../../lib/sheets-push";
import { tableItemsPass } from "../../../lib/table-push";

/**
 * A client's Airtable tables on the Operations page (session only), the same shape as Google Sheets. GET lists
 * the connected tables (?bases=1 the bases QC's token can see, ?base=<id> that base's tables); POST runs one
 * step: "connect" ({ baseId, tableId, content }), "reread", "content", "map" ({ mapping }), "push" ({ offset }),
 * "auto" ({ on }), "disconnect" ({ sheet }).
 */
export const maxDuration = 300;

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function workspaceOf(c: { url: string; key: string }, slug: string) {
  const [workspace] = await rows(c, `rr_workspaces?select=id,name&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  if (!workspace) throw new Error("Unknown client.");
  return { id: text(workspace.id), name: text(workspace.name) };
}

const fieldList = (content: SheetContent) => fieldsFor(content).map(({ key, label }) => ({ key, label }));
const shared = () => ({ configured: isAirtableConfigured(), fieldsByContent: { replies: fieldList("replies"), meetings: fieldList("meetings"), campaigns: fieldList("campaigns") } });

/** The fields shown for mapping, in table order: every writable field, plus the QC ID (shown, never mapped). */
const columnsOf = (fields: AirtableField[]) => fields.filter((field) => writable(field) || field.name.trim().toLowerCase() === AIRTABLE_QC_ID.toLowerCase());

async function tablesOf(c: { url: string; key: string }, workspaceId: string) {
  const all = (await rows(c, `rr_crm_push?select=*&workspace_id=eq.${encodeURIComponent(workspaceId)}&kind=like.airtable:*&order=created_at.asc`)) as unknown as Destination[];
  return all.filter((row) => row.api_key && row.status !== "disconnected");
}

/** Each table in the same shape the page uses for a sheet: headers, mapping by position, the QC ID column. */
function present(list: Destination[]) {
  return list.map((row) => {
    const saved = (row.config ?? {}) as unknown as AirtableConfig;
    const columns = columnsOf(saved.fields ?? []);
    return {
      ...presentDestination(row),
      content: contentOf(saved.content),
      config: {
        url: saved.url,
        tab: saved.tableName,
        headers: columns.map((field) => field.name),
        types: columns.map((field) => field.type),
        mapping: columns.map((field) => saved.mapping?.[field.id] ?? ""),
        qcIdColumn: columns.findIndex((field) => field.name.trim().toLowerCase() === AIRTABLE_QC_ID.toLowerCase()),
      },
    };
  });
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.get("bases")) {
      const bases = await listBases();
      if (!bases.ok) return NextResponse.json({ ok: false, error: bases.error }, { status: bases.status });
      const list = bases.data.map((base) => ({ id: base.id, name: base.name })).sort((a, b) => a.name.localeCompare(b.name));
      // The client's own base, picked in advance: the one saved on the client at onboarding, else the closest name.
      const [workspace] = await rows(config(), `rr_workspaces?select=name,airtable_base_id&slug=eq.${encodeURIComponent((await context.params).slug)}&limit=1`);
      return NextResponse.json({ ok: true, bases: list, suggested: suggestBase(list, text(workspace?.name), text(workspace?.airtable_base_id)) });
    }
    const base = text(params.get("base"));
    if (base) {
      const tables = await getBaseTables(base);
      if (!tables.ok) return NextResponse.json({ ok: false, error: tables.error }, { status: tables.status });
      const list = tables.data.map((table) => ({ id: table.id, name: table.name }));
      return NextResponse.json({ ok: true, tables: list, suggested: { replies: suggestTable(list, "replies"), meetings: suggestTable(list, "meetings"), campaigns: suggestTable(list, "campaigns") } });
    }
    const c = config();
    const workspace = await workspaceOf(c, (await context.params).slug);
    return NextResponse.json({ ok: true, ...shared(), tables: present(await tablesOf(c, workspace.id)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not read the Airtable settings." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const body = (await request.json().catch(() => ({}))) as Row;
  const action = text(body.action);
  try {
    const c = config();
    const workspace = await workspaceOf(c, (await context.params).slug);
    const existing = await tablesOf(c, workspace.id);
    const reply = async (extra: Row = {}) => NextResponse.json({ ok: true, ...extra, ...shared(), tables: present(await tablesOf(c, workspace.id)) });

    if (action === "create") {
      // "Create the table for me": every standard field, typed, mapped and live at once.
      const baseId = text(body.baseId);
      if (!/^app[A-Za-z0-9]+$/.test(baseId)) return NextResponse.json({ ok: false, error: "Pick a base." }, { status: 400 });
      const content = contentOf(body.content);
      const bases = await listBases();
      const baseName = bases.ok ? bases.data.find((base) => base.id === baseId)?.name ?? baseId : baseId;
      const table = await createQcTable(baseId, content);
      const kind = `airtable:${randomUUID().slice(0, 8)}`;
      const saved: AirtableConfig = { baseId, baseName, tableId: table.tableId, tableName: table.tableName, url: `https://airtable.com/${baseId}/${table.tableId}`, content, fields: table.fields, mapping: table.mapping, qcIdField: table.qcIdField };
      const made = await rest(c, "rr_crm_push", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ workspace_id: workspace.id, kind, provider: "airtable", api_key: "qc-airtable-token", account_id: baseId, account_name: baseName, status: "built", auto_push: true, build_log: [], config: saved }) });
      if (!made.ok) return NextResponse.json({ ok: false, error: `The table was made in Airtable but couldn't be saved here (${made.status}).` }, { status: 500 });
      return reply({ created: table.tableName });
    }

    if (action === "connect") {
      const baseId = text(body.baseId);
      const tableId = text(body.tableId);
      if (!/^app[A-Za-z0-9]+$/.test(baseId) || !/^tbl[A-Za-z0-9]+$/.test(tableId)) return NextResponse.json({ ok: false, error: "Pick a base and a table." }, { status: 400 });
      if (existing.some((row) => { const saved = (row.config ?? {}) as Partial<AirtableConfig>; return saved.baseId === baseId && saved.tableId === tableId; })) {
        return NextResponse.json({ ok: false, error: "That table is already connected for this client." }, { status: 409 });
      }
      const bases = await listBases();
      const baseName = bases.ok ? bases.data.find((base) => base.id === baseId)?.name ?? baseId : baseId;
      const table = await airtableTable(baseId, tableId);
      const content = contentOf(body.content);
      const kind = `airtable:${randomUUID().slice(0, 8)}`;
      // QC scans the table, matches what's there, then adds the standard fields it lacks.
      const filled = await addMissingAirtableFields(baseId, tableId, airtableSuggest(table.fields, fieldsFor(content)), content);
      const saved: AirtableConfig = { baseId, baseName, tableId, tableName: table.tableName, url: `https://airtable.com/${baseId}/${tableId}`, content, fields: filled.fields, mapping: filled.mapping };
      const made = await rest(c, "rr_crm_push", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ workspace_id: workspace.id, kind, provider: "airtable", api_key: "qc-airtable-token", account_id: baseId, account_name: baseName, status: "planned", auto_push: false, build_log: [], config: saved }),
      });
      if (!made.ok) return NextResponse.json({ ok: false, error: `Could not save the table (${made.status}).` }, { status: 500 });
      return reply({ added: filled.added });
    }

    const kind = text(body.sheet);
    const destination = existing.find((row) => row.kind === kind) ?? null;
    if (!destination) return NextResponse.json({ ok: false, error: "Connect a table first." }, { status: 400 });
    const saved = (destination.config ?? {}) as unknown as AirtableConfig;
    const content = contentOf(saved.content);

    if (action === "reread") {
      // The table's fields again: renamed or added fields show, confirmed choices are kept by field id.
      const table = await airtableTable(saved.baseId, saved.tableId);
      const suggested = airtableSuggest(table.fields, fieldsFor(content));
      const mapping = Object.fromEntries(table.fields.map((field) => [field.id, saved.mapping?.[field.id] ?? suggested[field.id] ?? ""]));
      await saveDestination(c, workspace.id, kind, { config: { ...saved, tableName: table.tableName, fields: table.fields, mapping } as unknown as Row });
      return reply();
    }
    if (action === "content") {
      const next = contentOf(body.content);
      if (next === content) return reply();
      const filled = await addMissingAirtableFields(saved.baseId, saved.tableId, airtableSuggest(saved.fields, fieldsFor(next)), next);
      await saveDestination(c, workspace.id, kind, { config: { ...saved, content: next, fields: filled.fields, mapping: filled.mapping, campaign_state: undefined } as unknown as Row, status: "planned" });
      return reply({ added: filled.added });
    }
    if (action === "map") {
      // The page sends one choice per shown field, in order; stored by field id so renames don't break it.
      const catalog = fieldsFor(content);
      const columns = columnsOf(saved.fields);
      const chosen = Array.isArray(body.mapping) ? (body.mapping as unknown[]) : [];
      const mapping: Record<string, string> = {};
      columns.forEach((field, index) => { if (writable(field)) mapping[field.id] = catalog.some((entry) => entry.key === chosen[index]) ? String(chosen[index]) : ""; });
      if (!Object.values(mapping).some(Boolean)) return NextResponse.json({ ok: false, error: "Map at least one field." }, { status: 400 });
      const qcIdField = await ensureQcIdField(saved.baseId, saved.tableId, saved.fields);
      const table = await airtableTable(saved.baseId, saved.tableId);
      await saveDestination(c, workspace.id, kind, { config: { ...saved, fields: table.fields, mapping, qcIdField } as unknown as Row, status: "built", ...(destination.status !== "built" ? { auto_push: true } : {}) });
      return reply();
    }
    if (action === "push") {
      if (destination.status !== "built") return NextResponse.json({ ok: false, error: "Confirm the field mapping first." }, { status: 400 });
      const done = await withPushLock(c, workspace.id, kind, 300_000, async () => {
        if (content !== "replies") {
          const result = await tableItemsPass(c, destination, { all: true });
          const summary = { pushed: result.pushed, created: result.created, updated: result.updated, unchanged: 0, failed: 0, errors: [] as string[], nextOffset: null, at: new Date().toISOString() };
          await saveDestination(c, workspace.id, kind, { last_push_at: summary.at, last_push_summary: summary as unknown as Row });
          return summary;
        }
        return pushPass(c, destination, { offset: Number(body.offset) || 0, budgetMs: 150_000 });
      });
      if (done === null) return NextResponse.json({ ok: false, error: "A push to this table is already running. Try again in a minute." }, { status: 409 });
      return reply({ summary: done });
    }
    if (action === "auto") {
      await saveDestination(c, workspace.id, kind, { auto_push: body.on === true });
      return reply();
    }
    if (action === "disconnect") {
      // QC Command stops pushing; the table and its records stay as they are.
      await rest(c, `rr_crm_push?workspace_id=eq.${encodeURIComponent(workspace.id)}&kind=eq.${encodeURIComponent(kind)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      await rest(c, `rr_crm_push_records?workspace_id=eq.${encodeURIComponent(workspace.id)}&provider=eq.${encodeURIComponent(recordKey(destination))}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return reply();
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "That step failed.";
    // The person's input, not the server: an unknown client is a 404, a link that isn't a sheet a 400.
    const status = /^Unknown client/.test(message) ? 404 : /doesn't look like|Pick a base/.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
