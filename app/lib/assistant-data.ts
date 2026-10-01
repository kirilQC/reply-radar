// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Read access to everything QC Command stores, for the MCP assistant and QC Bot.
 *
 * The purpose-built tools cover the common questions well, but every page in the app also reads tables
 * those tools never touch: tags, teammates' profiles, call logs, past reports, what each Slack brief
 * said, sync and webhook history, the audit trail, feedback, campaign and daily stats. Rather than a tool
 * per table, two general ones: `describe_data` (what exists, with live column names) and `query_data`
 * (filtered, ordered, counted reads of one table). Together with the specific tools that means there is
 * nothing on the site the assistant cannot look at, and it can join across tables itself.
 *
 * Read-only by construction: these only ever issue GETs. Secrets never leave: any column whose name says
 * it is a key, token, secret, password, ciphertext or webhook URL is stripped from every row, and the
 * two config tables that hold integration credentials are not offered at all.
 */

type Row = Record<string, unknown>;

/** Every table the app reads, with what a row is, so the model can pick the right one. */
export const DATA_TABLES: Record<string, string> = {
  rr_workspaces: "One row per client (its whole Configuration page). Columns: name, slug, timezone, website_url, logo_url, accent_color, client_brief, custom_system_prompt, brain_folder, slack_internal_channel_id, slack_external_channel_id, slack_extra_channel_ids, morning_brief_enabled, call_analysis_enabled, eow_report_enabled, granola_title_match, anthropic_model, created_at. Inside the guardrails JSON: guardrails->>messaging_doc_url (the client messaging doc), guardrails->>icp_prompt, guardrails->>follow_up_prompt, guardrails->>follow_up_threshold, guardrails->>reply_prompt, guardrails->>slack_internal_only, guardrails->>ai_ark_enrichment_enabled, guardrails->quick_templates. Select JSON fields like \"name,guardrails->>messaging_doc_url\" and filter them with column guardrails->>messaging_doc_url. Keys and webhooks are never shown, but each comes back as a has_<column> true/false flag (has_heyreach_api_key_ciphertext = HeyReach connected, has_clay_dnc_webhook_url = Clay DNC set up).",
  rr_leads: "Every lead (person) QC has a conversation with: name, title, company, LinkedIn, location, enrichment in raw_data, workspace_id.",
  rr_conversations: "One per LinkedIn conversation: lead_id, workspace_id, campaign, sender, sentiment, tier, follow-up urgency, last message times, reply counts.",
  rr_messages: "Every message in every conversation: conversation_id, direction (inbound/outbound), body, sent_at.",
  rr_scores: "AI judgements per conversation or lead: ICP / lead score, follow-up score, reasons.",
  rr_inbox_tag_assignments: "Which inbox tags (DQ, Scheduling, Discuss…) are on which conversations, and when.",
  rr_blocked_leads: "Leads that were blocked (deleted and refused forever), with who and when.",
  rr_campaign_stats: "Per-campaign HeyReach figures synced daily: sends, accepts, replies, rates, launch date, status. Primary key workspace_id + campaign_id.",
  rr_daily_stats: "Per-day, per-sender activity: connection requests, accepts, messages, replies.",
  rr_meetings: "Booked meetings: lead details, company, when, campaign, who it is with, notes, enrichment.",
  rr_deals: "CRM deals synced from HubSpot/Attio: name, stage, value, company, attribution to QC (verified / possible / not).",
  rr_call_logs: "Cold calling: every call outcome (Connected, Voicemail, Interested…), note, who called, when, lead.",
  rr_cold_call_jobs: "Background 'Fetch & enrich' jobs that build call lists from a campaign: status, counts.",
  rr_company_domains: "Company name to domain lookups used for enrichment and DNC.",
  rr_dnc: "Do-not-contact companies per client.",
  rr_onboarding_tasks: "Per-client onboarding checklist progress.",
  rr_onboarding_template_steps: "The onboarding checklist template.",
  rr_projects: "The internal Project management board: tasks per client, stage, priority, assignees, due date, blockers.",
  rr_profiles: "Teammates: name, title, photo, LinkedIn.",
  rr_profile_workspaces: "Which teammate owns which clients (profile_id + workspace_id).",
  rr_reports: "Every generated client report: template, period, title, sections, when.",
  rr_slack_automations: "Slack automation settings per client: morning brief / call analysis / EOW on or off, schedules.",
  rr_slack_briefs: "Every brief, call analysis and EOW report QC Bot posted: client, automation, the text, channel, when.",
  rr_slack_events: "QC Bot activity log: who asked what over Slack, tools used, outcome, tokens.",
  rr_slack_personal_assistants: "Personal assistant DMs: which teammate, which clients, schedule.",
  rr_granola_heartbeats: "When each Granola key was last checked and what calls it found.",
  rr_sync_runs: "Background sync history per client: type, started, finished, rows, errors.",
  rr_webhook_events: "Raw incoming webhook events (HeyReach replies, meetings) and whether they processed.",
  rr_audit_log: "The audit trail: every notable action and system event, source, status, detail.",
  rr_feedback: "Feedback and bug reports teammates submitted, with status.",
  rr_documents: "Client documents uploaded for AI context: name, type, when.",
  rr_brain_renders: "Cached readable layouts of QC Brain documents.",
  rr_graphs: "Saved inbox analytics graphs.",
};

/** Columns that must never be shown, whatever table they are in. */
const SECRET = /(^|_)(api_?key|apikey|ciphertext|secret|token|password|passwd|private_?key|webhook_?url|signing|credential|bearer)s?($|_)/i;

/** Secrets are dropped; whether each one is set survives as has_<column>, which is what questions need. */
const redact = (row: Row): Row => {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (SECRET.test(key)) out[`has_${key}`] = value !== null && value !== undefined && String(value).trim() !== "";
    else out[key] = value;
  }
  return out;
};

const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is"]);
const MAX = 1000;

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function get(path: string, count = false): Promise<{ rows: Row[]; total: number | null }> {
  const { url, key } = supabase();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(count ? { Prefer: "count=exact" } : {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 240);
    throw new Error(`Database ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const range = response.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  const body = await response.json().catch(() => []);
  return { rows: Array.isArray(body) ? body : [], total: Number.isFinite(total) ? total : null };
}

const ident = (value: unknown) => {
  const name = String(value ?? "").trim();
  if (!/^[a-z_][a-z0-9_]*(->>?[a-z0-9_]+)*$/i.test(name)) throw new Error(`"${name}" is not a column name.`);
  return name;
};

const tableName = (value: unknown) => {
  const name = String(value ?? "").trim();
  if (!(name in DATA_TABLES)) throw new Error(`Unknown table "${name}". Call describe_data to see the tables.`);
  return name;
};

let columnsCache: { at: number; value: Record<string, string[] | string> } | null = null;

export const DATA_TOOLS = [
  {
    name: "describe_data",
    description:
      "Lists every table behind QC Command (each page of the site reads from these) with what a row means and its live column names (secret columns omitted). Call it before query_data when you are not sure which table or column holds what you need, or when no specific tool answers the question: tags, teammates and who owns which client, call logs, past reports, every brief QC Bot posted, sync / webhook / audit history, feedback, campaign and daily stats, blocked leads, client settings.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "query_data",
    description:
      "Read rows from any QC Command table (see describe_data). Read-only. Filter with column / op / value (ops: eq, neq, gt, gte, lt, lte, like, ilike with * wildcards, in with comma-separated values, is null), order, and limit (up to 1000). Set countOnly to get just the number of matching rows, which is the right call for 'how many'. Pass client to filter tables that have workspace_id to one client. Embed related rows with PostgREST select syntax, e.g. select \"id,first_name,company,rr_conversations(sentiment,campaign_name)\". Use it to join the dots between sources: a lead's conversations, scores, tags, meetings, deals and call outcomes are all here.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name from describe_data, e.g. rr_call_logs." },
        select: { type: "string", description: "Columns to return, comma-separated, PostgREST syntax. Default *." },
        filters: {
          type: "array",
          description: "All must match.",
          items: {
            type: "object",
            properties: { column: { type: "string" }, op: { type: "string" }, value: { type: "string" } },
            required: ["column", "op", "value"],
          },
        },
        client: { type: "string", description: "Optional client name or slug; filters workspace_id to that client." },
        order: { type: "string", description: "Column to sort by, e.g. created_at." },
        ascending: { type: "boolean", description: "Sort ascending. Default false (newest first)." },
        limit: { type: "number", description: "Rows to return, default 100, max 1000." },
        countOnly: { type: "boolean", description: "Return only the count of matching rows." },
      },
      required: ["table"],
    },
  },
];

export async function runDataTool(
  name: string,
  input: Row,
  resolveClientId: (client: unknown) => Promise<string>,
  clientNames: () => Promise<Map<string, string>> = async () => new Map(),
): Promise<unknown> {
  if (name === "describe_data") {
    if (!columnsCache || Date.now() - columnsCache.at > 10 * 60_000) {
      const entries = await Promise.all(
        Object.keys(DATA_TABLES).map(async (table) => {
          try {
            const { rows } = await get(`${table}?select=*&limit=1`);
            return [table, rows[0] ? Object.keys(rows[0]).filter((key) => !SECRET.test(key)) : "no rows yet"] as const;
          } catch (error) {
            return [table, `unavailable (${error instanceof Error ? error.message.slice(0, 60) : "error"})`] as const;
          }
        }),
      );
      columnsCache = { at: Date.now(), value: Object.fromEntries(entries) };
    }
    return Object.entries(DATA_TABLES).map(([table, about]) => ({ table, about, columns: columnsCache!.value[table] }));
  }

  if (name === "query_data") {
    const table = tableName(input.table);
    const params: string[] = [];
    const select = String(input.select ?? "*").trim() || "*";
    if (SECRET.test(select)) throw new Error("That column holds a secret and cannot be read.");
    params.push(`select=${encodeURIComponent(select)}`);
    for (const filter of Array.isArray(input.filters) ? input.filters : []) {
      const f = filter as Row;
      const column = ident(f.column);
      const op = String(f.op ?? "").trim().toLowerCase();
      if (!OPS.has(op)) throw new Error(`Unknown filter op "${op}".`);
      if (SECRET.test(column)) throw new Error("That column holds a secret and cannot be filtered on.");
      const raw = String(f.value ?? "");
      const value = op === "in" ? `(${raw.split(",").map((v) => `"${v.trim().replace(/"/g, "")}"`).join(",")})` : op === "is" ? (raw.toLowerCase() === "null" ? "null" : raw.toLowerCase() === "true" ? "true" : "false") : raw;
      params.push(`${encodeURIComponent(column)}=${op}.${encodeURIComponent(value)}`);
    }
    if (input.client) params.push(`workspace_id=eq.${encodeURIComponent(await resolveClientId(input.client))}`);
    if (input.order) params.push(`order=${encodeURIComponent(ident(input.order))}.${input.ascending ? "asc" : "desc"}.nullslast`);
    const countOnly = Boolean(input.countOnly);
    const limit = countOnly ? 1 : Math.min(Math.max(Number(input.limit) || 100, 1), MAX);
    params.push(`limit=${limit}`);
    const { rows, total } = await get(`${table}?${params.join("&")}`, true);
    if (countOnly) return { table, count: total ?? rows.length };
    // Every row that belongs to a client says which one, by its real name, so nothing has to be inferred
    // from a campaign code.
    const names = rows.some((row) => "workspace_id" in row) ? await clientNames() : new Map<string, string>();
    const clean = rows.map((row) => {
      const out = redact(row);
      if ("workspace_id" in row) return { client: names.get(String(row.workspace_id)) ?? "(unknown client)", ...out };
      return out;
    });
    return { table, total: total ?? clean.length, returned: clean.length, rows: clean };
  }

  throw new Error(`There is no tool called "${name}".`);
}

/* ── Big lists become files ──────────────────────────────────────────────────────────────────────
 * A tool that returns hundreds of rows used to have the model type every one of them into the answer,
 * which took minutes and helped nobody: the reader wanted the number and a spreadsheet. Now any result
 * holding a list longer than BIG_LIST is turned into a CSV that goes straight to the reader, and the
 * model keeps the rows (up to MODEL_ROWS, enough to count, rank and summarise) plus a note telling it
 * not to write them out. */

const BIG_LIST = 25;
const MODEL_ROWS = 300;
/** Tools whose lists are reference material for the model, not something anyone wants as a spreadsheet. */
const NO_CSV = new Set(["list_clients", "help_center", "describe_data", "brain_search", "brain_client", "brain_skills", "airtable_tables", "list_project_views", "list_onboarding_template", "slack_channels", "heyreach_export_list"]);

const flat = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};
const cell = (value: unknown) => {
  const s = flat(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(list: Row[]): string {
  const columns: string[] = [];
  for (const row of list) for (const key of Object.keys(row)) if (!columns.includes(key) && columns.length < 60) columns.push(key);
  return [columns.join(","), ...list.map((row) => columns.map((c) => cell(row[c])).join(","))].join("\n");
}

/** The longest list of objects in a result, top-level or one level down. */
function findList(result: unknown): { path: string | null; list: Row[] } | null {
  const isRows = (v: unknown): v is Row[] => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x));
  if (isRows(result)) return { path: null, list: result };
  if (!result || typeof result !== "object") return null;
  let best: { path: string; list: Row[] } | null = null;
  for (const [key, value] of Object.entries(result as Row)) if (isRows(value) && (!best || value.length > best.list.length)) best = { path: key, list: value };
  return best;
}

/** Long lists collected during one answer, so they can leave as ONE file rather than one per lookup. */
export type DatasetStore = Map<string, { tool: string; rows: Row[] }>;

/**
 * A long list is kept server-side as a dataset for this answer. The model sees enough to count and
 * summarise plus a dataset id; the reader gets a file only when export_csv is called (or, if the model
 * never calls it, one merged file at the end of the answer).
 */
export function bigListToDataset(tool: string, result: unknown, store: DatasetStore): unknown {
  if (NO_CSV.has(tool)) return result;
  const found = findList(result);
  if (!found || found.list.length <= BIG_LIST) return result;
  const id = `ds${store.size + 1}`;
  store.set(id, { tool, rows: found.list });
  const partial = found.list.length > MODEL_ROWS ? ` You were given the first ${MODEL_ROWS}; count breakdowns from those and say so.` : " You have every row: count breakdowns exactly from them, never approximate or write \"~\".";
  const note = `${found.list.length} rows, held as dataset ${id}. Do NOT write these rows out. Give the exact count, the useful breakdowns and at most 10 example rows. To hand the reader a spreadsheet, call export_csv ONCE at the end with every dataset that makes up the final list (they are merged and de-duplicated into a single file).${partial}`;
  const kept = found.list.slice(0, MODEL_ROWS);
  return found.path === null
    ? { rows: kept, totalRows: found.list.length, datasetId: id, instruction: note }
    : { ...(result as Row), [found.path]: kept, [`${found.path}Total`]: found.list.length, datasetId: id, instruction: note };
}

export const EXPORT_TOOL = {
  name: "export_csv",
  description:
    "Turn the long lists you gathered in this answer (each tool result over 25 rows says its datasetId) into ONE CSV the reader downloads. Pass every dataset that makes up the final list; they are merged into one file. Pass dedupeBy with the column that identifies a row (e.g. name, linkedin_url, id) to drop duplicates across lookups. Call it once per answer, at the end, only when a list is the answer or a spreadsheet was asked for.",
  input_schema: {
    type: "object",
    properties: {
      datasets: { type: "array", items: { type: "string" }, description: "Dataset ids, e.g. [\"ds1\", \"ds3\"]." },
      dedupeBy: { type: "string", description: "Column to de-duplicate on. Optional." },
      name: { type: "string", description: "A short file name without extension, e.g. cisos-contacted." },
    },
    required: ["datasets"],
  },
};

const slug = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/** Merges datasets into one CSV file. */
export function exportDatasets(store: DatasetStore, input: Row): { file: { name: string; mime: string; content: string }; rows: number } {
  const ids = (Array.isArray(input.datasets) ? input.datasets : [input.datasets]).map(String).filter((id) => store.has(id));
  const chosen = ids.length ? ids : [...store.keys()];
  if (!chosen.length) throw new Error("There is no long list in this answer to export.");
  const merged: Row[] = [];
  const seen = new Set<string>();
  const by = String(input.dedupeBy ?? "").trim();
  for (const id of chosen) {
    for (const row of store.get(id)!.rows) {
      const key = by && row[by] !== undefined ? String(row[by]).toLowerCase().trim() : JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const base = slug(input.name) || slug(store.get(chosen[0])!.tool);
  return { file: { name: `${base}-${stamp}.csv`, mime: "text/csv", content: toCsv(merged) }, rows: merged.length };
}
