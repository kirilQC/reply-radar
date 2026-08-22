// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The tools the assistant is allowed to use, and the code that runs them.
 *
 * This is the whole of what the chat box can do. Claude receives the definitions below, asks for one
 * by name, and `runTool` answers — there is no path from a typed question to anything not listed
 * here. That is the security model: not an instruction telling the model to behave, but an allowlist.
 * Adding a tool is a deliberate act; a cleverly worded prompt is not.
 *
 * ── The one tool that is not read-only ──────────────────────────────────────────────────────────
 * `brain_write` is the single exception, and it is a narrow one: it cannot send a message, pause a
 * campaign or touch a database. All it can do is open a pull request against the QC Brain repo, which
 * a person then has to merge. That is deliberate — the brain is what every teammate's Claude Code
 * reads, so a wrong edit becomes everybody's truth silently, and nothing about a wrong ICP announces
 * itself. A proposal that sits until somebody looks at it is the correct shape for a model's write
 * access to shared memory. Nothing else in this file writes anywhere.
 *
 * ── Why the numbers come from two different places ──────────────────────────────────────────────
 * `rr_messages` has no `workspace_id`. It hangs off `rr_conversations`, which has one, so a
 * per-client reply count over a date range would need either a PostgREST embed (unproven in this
 * repo — nothing else here uses one, and the deletion path removes messages explicitly rather than
 * trusting a cascade, which suggests the foreign key may not exist) or thousands of conversation ids
 * chunked into fifty-id batches.
 *
 * Slowness is not the objection — this assistant is explicitly allowed to take its time. The
 * objection is that HeyReach already computes those windowed counts and is the system of record for
 * what was sent, so reconstructing them from our own message rows would be a second, less
 * trustworthy answer to a question that already has an authoritative one.
 *
 * So the split is deliberate and it is by question, not by convenience:
 *
 * - **Counts per client, per campaign, over a window** come from HeyReach, which computes them
 *   itself in one call and is the system of record for what was sent.
 * - **Reply content, the AI's read of it, and who is waiting on us** come from our tables, because HeyReach
 *   does not know about any of that.
 * - **All-time and to-date totals across every client** come from our tables with `count=exact`,
 *   exactly as the home page does, so the assistant and the dashboard can never disagree.
 *
 * Each tool's description says which, because a model that does not know it will average the two.
 *
 * ── Clients are named, not identified ───────────────────────────────────────────────────────────
 * Every client-scoped tool takes a client *name or slug*, because that is what a person types.
 * `resolveClient` does the matching and, on a miss, returns the list of real names — a model told
 * "no such client" invents one, whereas a model handed the actual names picks the right one.
 */

import { campaignStatusFor } from "./heyreach-campaigns";
import {
  createRecords as airtableCreate,
  findTableByName,
  getBaseTables,
  listRecords as airtableList,
  updateRecords as airtableUpdate,
  type AirtableResult,
  type AirtableTable,
} from "./airtable";
import { countRows } from "./rest-count";
import { isOurCampaign } from "../../shared/campaign-code.mjs";
import { containsAny } from "../../shared/postgrest-filter.mjs";
import { exportFilename, rowsToCsv } from "../../shared/answer-export.mjs";
import * as heyreach from "./heyreach-api";
import { BRAIN_URL, brainConfigured, brainCorpus, brainFile, brainFiles, brainTree, forgetBrainTree, proposeBrainEdit } from "./brain";
import { searchBrain } from "../../shared/brain-search.mjs";
import { clientLabel, clientOf, clientSkeleton, clientsIn, fileKind, fileTitle, isReadable, parseSkill, skillClient } from "../../shared/brain-structure.mjs";
import { scanChannel, resolveChannelNames, resolveUserNames, transcript, slackReadable } from "./slack";
import { normalizeChannelId } from "./slack-channel";
import { addMeeting } from "./meetings";

type Row = Record<string, unknown>;

/** Where the brain keeps its slash commands, the same folder Claude Code reads them from. */
const COMMANDS = ".claude/commands/";

/** A file a tool produced, on its way to the browser. */
export type ToolFile = { name: string; mime: string; content: string };

/**
 * How a file travels past the model rather than through it.
 *
 * A tool result is JSON that lands in the model's context, and a two-thousand-row CSV must not. A
 * result carrying this key has the file lifted off it by the route, sent to the browser as its own
 * event, and deleted from what the model is shown — which is also the only way the downloaded rows
 * are guaranteed to be the rows HeyReach returned rather than a very convincing retyping of them.
 */
const FILE_KEY = "__file";

export function takeFile(result: unknown): { file: ToolFile | null; rest: unknown } {
  if (!result || typeof result !== "object" || !(FILE_KEY in result)) return { file: null, rest: result };
  const { [FILE_KEY]: file, ...rest } = result as Row & { [FILE_KEY]: ToolFile };
  return { file, rest };
}

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(object) : []);
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
/** A list-of-strings argument, tolerating the single string a model sometimes sends instead. */
const strings = (value: unknown) => (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);

/**
 * Bounds every list a tool can return.
 *
 * Three hundred rather than the fifty this started with, because "analyse every conversation from
 * this client" is a question people actually ask and fifty rows silently turned it into "analyse a
 * sample and generalise" — an answer that reads as authoritative and is not. Rows are cheap; a wrong
 * conclusion drawn from a truncated list is not.
 *
 * There is still a ceiling, because past a few hundred conversations the thread bodies alone crowd
 * out the model's context and the answer degrades for a different reason.
 */
const MAX_ROWS = 300;
/**
 * Threads make `heyreach_inbox_search` far heavier per row than the other list tools — every
 * conversation arrives with its full message history — so it keeps the old, lower bound.
 */
const MAX_THREADS = 50;
const rowLimit = (value: unknown, fallback: number, ceiling = MAX_ROWS) =>
  Math.min(Math.max(Number(value) || fallback, 1), ceiling);

/**
 * PostgREST takes ids in the URL, so a request for three hundred of them is a request with an
 * eleven-kilobyte query string — which some proxy between here and Supabase will refuse, usually by
 * truncating rather than erroring. Fifty at a time, run together, keeps every URL short.
 */
const ID_BATCH = 50;

/**
 * The ceiling on an exported file, which is far above `MAX_ROWS` because none of these rows are read
 * by the model. A lead list is routinely a few thousand people and half of one is not the list; the
 * only cost is the sequential walk through HeyReach's pages, which the export is allowed to take.
 */
const EXPORT_ROWS = 5_000;

async function dbByIds(query: (ids: string[]) => string, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += ID_BATCH) batches.push(ids.slice(start, start + ID_BATCH));
  const pages = await Promise.all(batches.map(async (batch) => rows(await db(query(batch)))));
  return pages.flat();
}

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function db(path: string): Promise<unknown> {
  const { url, key } = supabase();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`Supabase ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json().catch(() => []);
}

/* ── Clients ─────────────────────────────────────────────────────────────────────────────────── */

type Client = { id: string; name: string; slug: string; timezone: string; createdAt: string; apiKey: string };

async function clients(): Promise<Client[]> {
  const raw = rows(
    await db("rr_workspaces?select=id,name,slug,timezone,created_at,heyreach_api_key_ciphertext&order=name.asc"),
  );
  return raw.map((row) => ({
    id: text(row.id),
    name: text(row.name),
    slug: text(row.slug),
    timezone: text(row.timezone) || "America/New_York",
    createdAt: text(row.created_at),
    apiKey: text(row.heyreach_api_key_ciphertext),
  }));
}

/**
 * Finds the client someone meant.
 *
 * Exact slug, then exact name, then a substring either way — "steadywell", "Steadywell", "steady"
 * and "SW" all have to land, because none of them is wrong and a person typing into a chat box will
 * type all four. Ambiguity is an error rather than a first match: "which Max?" is a better answer
 * than confidently reporting on the wrong workspace.
 */
async function resolveClient(name: unknown): Promise<Client> {
  const wanted = text(name).toLowerCase();
  const all = await clients();
  if (!wanted) throw new Error(`Name a client. The clients are: ${all.map((c) => c.name).join(", ")}.`);
  const exact = all.filter((c) => c.slug.toLowerCase() === wanted || c.name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = all.filter(
    (c) => c.name.toLowerCase().includes(wanted) || c.slug.toLowerCase().includes(wanted),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${text(name)}" matches several clients: ${partial.map((c) => c.name).join(", ")}. Ask which.`);
  }
  throw new Error(`There is no client called "${text(name)}". The clients are: ${all.map((c) => c.name).join(", ")}.`);
}

/** A client with a HeyReach key, for the tools that cannot work without one. */
async function connectedClient(name: unknown): Promise<Client> {
  const client = await resolveClient(name);
  if (!client.apiKey) throw new Error(`${client.name} has no HeyReach API key saved, so HeyReach cannot be queried for them.`);
  return client;
}

/* ── Airtable, addressed only ever by client ────────────────────────────────────────────────────
 *
 * The assistant never sees a base id and cannot be handed one — a base is reached by naming the
 * client, and this resolves their `airtable_base_id`. That is the whole guard on writes: the model can
 * only touch a base that belongs to a client Reply Radar already knows, never an arbitrary one it was
 * told about in a message. A client with no base linked is a plain error, not an empty result, because
 * "this client is not on Airtable" and "Airtable is broken" want opposite responses.
 */

/**
 * Bases that are not a client but that the assistant is still allowed to reach, by name.
 *
 * The guard above is "only a base Reply Radar already knows, never an arbitrary id from a message" — a
 * fixed, hardcoded allowlist keyed by name keeps that property intact: this is still a known base reached
 * by name, not a base id the model was handed in Slack. "Client Template" is QC's shared onboarding
 * template base; it is deliberately NOT a workspace (it is not a client and would clutter the client list),
 * so it is reached this way instead. Match is tolerant on purpose — "the client template base" resolves too.
 */
const NAMED_BASES: Array<{ key: string; name: string; baseId: string }> = [
  { key: "client template", name: "Client Template", baseId: "apphji94rxZohBNno" },
];

async function airtableBaseFor(name: unknown): Promise<{ client: Client; baseId: string }> {
  const wanted = text(name).trim().toLowerCase();
  const named = NAMED_BASES.find((entry) => wanted === entry.key || wanted.includes(entry.key));
  if (named) {
    // A synthetic client so the rest of the Airtable path is unchanged; it has no workspace row, so its
    // id and HeyReach key are blank — nothing in the Airtable tools reads them.
    const client: Client = { id: "", name: named.name, slug: named.key, timezone: "America/New_York", createdAt: "", apiKey: "" };
    return { client, baseId: named.baseId };
  }
  const client = await resolveClient(name);
  const rows_ = rows(await db(`rr_workspaces?select=airtable_base_id&id=eq.${encodeURIComponent(client.id)}&limit=1`));
  const baseId = text(rows_[0]?.airtable_base_id);
  if (!baseId) throw new Error(`${client.name} has no Airtable base linked in Reply Radar, so their Airtable cannot be reached. Link one on the admin page.`);
  return { client, baseId };
}

/** Unwraps an Airtable result, turning its failure into a thrown error the loop reports to the model. */
function airtableData<T>(result: AirtableResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/**
 * One table in a base, found by exact id or by name.
 *
 * Resolved against the live schema every time, never trusted from the model, because a base's field
 * names and even table ids drift between clients (see `app/lib/airtable.ts`) — an id half-remembered
 * from another client's base would otherwise write into the wrong place with nothing to show it was
 * wrong. On a miss it lists the real tables so the next turn picks the right one.
 */
function resolveAirtableTable(tables: AirtableTable[], wanted: unknown): AirtableTable {
  const asked = text(wanted);
  if (!asked) throw new Error(`Name a table. The tables are: ${tables.map((t) => t.name).join(", ")}.`);
  const byId = tables.find((t) => t.id === asked);
  const table = byId ?? findTableByName(tables, asked);
  if (!table) throw new Error(`There is no table called "${asked}" in this base. The tables are: ${tables.map((t) => t.name).join(", ")}.`);
  return table;
}

/**
 * The field names a table actually has, and the check that a write only uses them.
 *
 * A value written to a field that does not exist is rejected by Airtable rather than guessed at, and
 * this catches it one step earlier with a message that names every real field — which is what turns a
 * model's wrong guess into a corrected second attempt instead of a dead write. Field names are the
 * contract and they differ per client, so this is deliberately strict.
 */
function checkFields(table: AirtableTable, fields: Row): Row {
  const known = new Set((table.fields ?? []).map((field) => field.name));
  const unknown = Object.keys(fields).filter((name) => !known.has(name));
  if (unknown.length) {
    throw new Error(
      `${table.name} has no field${unknown.length === 1 ? "" : "s"} called ${unknown.map((name) => `"${name}"`).join(", ")}. Its fields are: ${[...known].join(", ")}. Read the table first and use the exact names.`,
    );
  }
  return fields;
}

/** How many rows a read returns to the model, and the ceiling on one write, so neither runs away. */
const AIRTABLE_READ_ROWS = 50;
const AIRTABLE_WRITE_ROWS = 50;

/* ── Conversations, enriched with the person behind them ─────────────────────────────────────── */

/**
 * Where Reply Radar's AI judgements actually live.
 *
 * `rr_conversations` has `score` and `tier` columns and this used to read them, which produced the
 * worst kind of wrong answer: asked for the best replies of the day, the assistant reported that
 * "the scoring engine hasn't processed today's conversations yet" and ranked them by reading the
 * text itself. Nothing was behind schedule. Those two columns are left over from an earlier design
 * and nothing in the codebase has ever written to them, so they are null for every row that has ever
 * existed and always will be — a fact no amount of waiting changes.
 *
 * What the pipeline does produce is nested inside `raw_data.reply_radar`: sentiment and follow-up
 * urgency on the message, ICP score on the lead. Those are the same fields the inbox ranks by, which
 * is the point — the assistant and the inbox should never disagree about who is worth answering.
 */
const judgement = (row: Row): Row => {
  const raw = object(row.raw_data);
  return object(raw.reply_radar);
};

/** The pipeline writes "positive" | "neutral" | "negative"; anything else is not an opinion. */
const sentimentOf = (value: unknown) => {
  const said = text(value).toLowerCase();
  return ["positive", "neutral", "negative"].includes(said) ? said : null;
};

/**
 * Attaches lead details and the latest reply body to a set of conversations.
 *
 * Two batched queries regardless of how many conversations there are — leads, then messages — each
 * split into fifty-id requests that run together. That is what lets a caller ask for three hundred
 * conversations and get three hundred rather than a truncated URL's worth.
 */
async function describeConversations(conversationRows: Row[]): Promise<Row[]> {
  if (!conversationRows.length) return [];
  const ids = conversationRows.map((row) => text(row.id)).filter(Boolean);
  const leadIds = [...new Set(conversationRows.map((row) => text(row.lead_id)).filter(Boolean))];

  const [leadRows, messageRows] = await Promise.all([
    dbByIds(
      (batch) => `rr_leads?select=id,name,role,company,linkedin_profile_url,workspace_id,raw_data&id=in.(${batch.join(",")})`,
      leadIds,
    ),
    // Every message for these conversations, not just the newest: PostgREST has no per-group limit, so
    // the newest is picked out below. Deliberately unbounded — a row cap here would drop whole
    // conversations' messages rather than trimming each one, and a blank last reply looks like data.
    dbByIds(
      (batch) =>
        `rr_messages?select=conversation_id,direction,body,sent_at,raw_data&conversation_id=in.(${batch.join(",")})&order=sent_at.desc`,
      ids,
    ),
  ]);
  const leadById = new Map(rows(leadRows).map((row) => [text(row.id), row]));
  // Only the most recent message per conversation. The rest is what `read_conversation` is for, and
  // returning whole threads here would flood the context with sequences the question never asked about.
  const latest = new Map<string, Row>();
  // The newest *inbound* message separately, because that is the one the pipeline judged. When we
  // sent the last message, the sentiment on it would be our own draft's, not the lead's opinion.
  const latestInbound = new Map<string, Row>();
  for (const message of rows(messageRows)) {
    const key = text(message.conversation_id);
    if (!latest.has(key)) latest.set(key, message);
    if (text(message.direction) === "inbound" && !latestInbound.has(key)) latestInbound.set(key, message);
  }

  return conversationRows.map((row) => {
    const lead = leadById.get(text(row.lead_id)) ?? {};
    const message = latest.get(text(row.id)) ?? {};
    const judged = judgement(latestInbound.get(text(row.id)) ?? {});
    const leadJudged = judgement(lead);
    const icp = leadJudged.icp_score;
    return {
      conversationId: text(row.id),
      name: text(lead.name),
      role: text(lead.role),
      company: text(lead.company),
      profileUrl: text(lead.linkedin_profile_url),
      lastMessageAt: text(row.last_message_at),
      lastMessageFrom: text(row.last_message_direction) === "inbound" ? "lead" : "us",
      lastMessage: text(message.body).slice(0, 600),
      sentiment: sentimentOf(judged.sentiment),
      // 0–10, and only meaningful once the pipeline has looked: an unanalysed reply reports null
      // rather than 0, because zero urgency and no opinion are opposite things to rank on.
      followUpUrgency: text(judged.followup_analyzed_at) ? Number(judged.followup_urgency) || 0 : null,
      followUpReason: text(judged.followup_reason) || null,
      leadScore: icp === undefined || icp === null ? null : Number(icp) || 0,
      leadScoreReason: text(leadJudged.icp_reason) || null,
    };
  });
}

/** `last_message_direction=eq.inbound` — the lead spoke last, so the ball is with us. */
const AWAITING_US = "last_message_direction=eq.inbound";


async function conversationsFor(
  client: Client | null,
  { order, limit, since, awaitingUs }: { order: string; limit: number; since?: string; awaitingUs?: boolean },
): Promise<Row[]> {
  const filters = [
    client ? `workspace_id=eq.${encodeURIComponent(client.id)}` : "",
    awaitingUs ? AWAITING_US : "",
    since ? `last_message_at=gte.${encodeURIComponent(since)}` : "",
  ].filter(Boolean);
  const path = `rr_conversations?select=id,lead_id,workspace_id,last_message_at,last_message_direction${filters.length ? `&${filters.join("&")}` : ""}&order=${order}&limit=${limit}`;
  return describeConversations(rows(await db(path)));
}

/* ── Tool definitions ────────────────────────────────────────────────────────────────────────── */

type Schema = { type: "object"; properties: Row; required?: string[] };
export type ToolDefinition = { name: string; description: string; input_schema: Schema };

const CLIENT_ARG = {
  client: { type: "string", description: "Client name or slug, e.g. \"Steadywell\" or \"steadywell\"." },
};
const WINDOW_ARGS = {
  since: { type: "string", description: "ISO 8601 start of the window, inclusive, e.g. 2026-08-01." },
  until: { type: "string", description: "ISO 8601 end of the window, exclusive." },
};

// How much of a Slack channel a scan reads. A windowed scan defaults to a month; a full scan reads back to
// the channel's creation, both bounded by a message cap so a long channel cannot flood the model.
const SLACK_SCAN_DEFAULT_DAYS = 30;
const SLACK_SCAN_DEFAULT = 400;
const SLACK_SCAN_FULL_DEFAULT = 1200;
const SLACK_SCAN_MAX = 1500;

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_clients",
    description:
      "Every client workspace in Reply Radar: name, slug, time zone, when they were added, and whether a HeyReach key is connected. Call this first when a question names a client you have not yet resolved, or asks how many clients there are.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "client_summary",
    description:
      "The client's own briefing as configured in Reply Radar: what they sell, who they sell to, their ICP, their positioning and how they want to sound. This is the background every scoring and drafting run for that client already uses, so reading it is how you reason about the same client the pipeline does rather than from the company name alone. Call it before writing copy for a client, before judging whether a lead or a list fits, and before explaining why a lead scored the way it did. Returns whether a briefing exists — an empty one means nobody has pasted the /client-summary output into that client's configuration yet, which is worth saying plainly instead of guessing at the answer.",
    input_schema: {
      type: "object",
      properties: { client: { type: "string", description: "Client name or slug, e.g. \"willow\" or \"Bluevia Health\"." } },
      required: ["client"],
    },
  },
  {
    name: "database_totals",
    description:
      "Exact all-time totals across every client: leads, conversations, replies received, and clients. Also accepts a window to count replies received in a period. These are counted in Reply Radar's own database and match the dashboard exactly. They are NOT per client — for one client's numbers use heyreach_campaign_metrics.",
    input_schema: { type: "object", properties: { ...WINDOW_ARGS } },
  },
  {
    name: "recent_replies",
    description:
      "The most recent conversations, newest first, with the lead's name, role, company, LinkedIn URL, their latest message, and Reply Radar's own read of it: the sentiment of their reply, how urgently it needs a follow-up (0-10), and the lead's ICP score. Any of those can be null, which means the pipeline has not analysed that row yet — it does not mean zero, and it must never be reported as a low score. Optionally scoped to one client. This is the tool for 'what came in', 'show me recent replies', or any question about what people actually said.",
    input_schema: {
      type: "object",
      properties: {
        ...CLIENT_ARG,
        limit: { type: "integer", description: `How many, up to ${MAX_ROWS}. Default 15. Ask for what the question needs — if it is about all of a client's replies, ask for hundreds rather than analysing the default and generalising.` },
        since: { type: "string", description: "ISO 8601 date; only conversations active on or after this." },
      },
    },
  },
  {
    name: "awaiting_reply",
    description:
      "People who replied and have not been answered — the follow-up list. Oldest wait first, so the top of the list is the most overdue. Optionally scoped to one client. Use this for 'who needs following up', 'who are we ignoring', or a follow-up report.",
    input_schema: {
      type: "object",
      properties: { ...CLIENT_ARG, limit: { type: "integer", description: `How many, up to ${MAX_ROWS}. Default 25. For a complete follow-up report ask for the maximum rather than the default.` } },
    },
  },
  {
    name: "find_person",
    description:
      "Find ONE named individual by name or LinkedIn profile URL across every client, with their full conversation history and Reply Radar's read of each reply. Use this when a question names a person. For a question about a kind of person rather than a named one — every CISO, everyone at Stripe, all the VPs of Engineering — use search_leads instead; this tool cannot match a job title.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "A person's name, or their LinkedIn profile URL." } },
      required: ["query"],
    },
  },
  {
    name: "search_leads",
    description:
      "Search everyone in Reply Radar's own database by job title, company or name. This is the tool for \"list the CISOs in our database\", \"who do we have at Stripe\", \"every VP of Engineering we have replied to\" — any question about a category of person rather than a named one. Matching is case-insensitive substring, so \"security\" finds \"Head of Security\". Give role as a LIST of every spelling of the title, because titles are free text as the person wrote them on LinkedIn: for CISOs pass [\"CISO\", \"Chief Information Security Officer\", \"Chief Security Officer\"], and anyone matching any of them is returned. Searches people, never message text. Returns the exact total match count as well as the rows, so you can always say how many there are even when the list is capped. Each person carries a leadScore, which is how well they fit the client's ideal customer; it is null for anyone who has not been analysed, which is not the same as a low score.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "array",
          items: { type: "string" },
          description: "Job-title fragments. Anyone whose title contains ANY of them matches. Always pass every spelling and abbreviation of the title you mean, including the acronym and the words behind it.",
        },
        company: {
          type: "array",
          items: { type: "string" },
          description: "Company-name fragments. Anyone at a company containing ANY of them matches.",
        },
        name: {
          type: "array",
          items: { type: "string" },
          description: "Name fragments. Anyone whose name contains ANY of them matches.",
        },
        ...CLIENT_ARG,
        repliedOnly: { type: "boolean", description: "Only people who have actually replied to us. Off by default, which includes everyone in the database whether or not they ever answered." },
        limit: { type: "integer", description: `How many rows, up to ${MAX_ROWS}. Default 100. The total count is returned regardless of this.` },
      },
    },
  },
  {
    name: "read_conversation",
    description:
      "The full message thread of one conversation, oldest first, marked as sent by us or by the lead. Take the conversationId from recent_replies, awaiting_reply or find_person. Use this before drafting anything or when the question is about what exactly was said.",
    input_schema: {
      type: "object",
      properties: { conversationId: { type: "string", description: "Conversation id (a UUID)." } },
      required: ["conversationId"],
    },
  },
  {
    name: "heyreach_campaigns",
    description:
      "Live campaign status for one client, straight from HeyReach: which campaigns are active and still contacting new leads, which have worked through their list, which are scheduled or paused, how many leads are pending, who is sending, and how many days of sending are left. Only campaigns QC launched are included — a client's own pre-engagement campaigns are excluded by naming convention. Use this for 'what's running', 'what's live', campaign status, or when leads will run out.",
    input_schema: { type: "object", properties: { ...CLIENT_ARG }, required: ["client"] },
  },
  {
    name: "heyreach_campaign_metrics",
    description:
      "Per-campaign performance for one client from HeyReach: connections sent and accepted, messages sent, conversations started, replies received, leads auto-tagged interested, and HeyReach's own acceptance and reply rates. Optionally over a date window; both since and until must be given together. This is the authoritative source for one client's reply counts. Rates come back as percentages already converted, but read the rateWarning in the result before ranking anything by one. Unique leads contacted is not available per campaign — heyreach_workspace_totals is the only place HeyReach reports it.",
    input_schema: { type: "object", properties: { ...CLIENT_ARG, ...WINDOW_ARGS }, required: ["client"] },
  },
  {
    name: "heyreach_senders",
    description:
      "The LinkedIn accounts sending for one client, and their health: whether each is switched on, whether its LinkedIn session is still valid, and how many campaigns it is on. An account that is active but whose session has expired is silently sending nothing — call this when a client's numbers have dropped.",
    input_schema: { type: "object", properties: { ...CLIENT_ARG }, required: ["client"] },
  },
  {
    name: "heyreach_person_campaigns",
    description:
      "Which HeyReach campaigns a specific person is enrolled in, by LinkedIn profile URL, for one client. Answers 'is this person already being worked?' and 'which campaign did this lead come from?'. Only campaigns QC launched are returned.",
    input_schema: {
      type: "object",
      properties: { ...CLIENT_ARG, profileUrl: { type: "string", description: "Their LinkedIn profile URL." } },
      required: ["client", "profileUrl"],
    },
  },
  {
    name: "heyreach_campaign_sequence",
    description:
      "The actual message sequence of one campaign: each step, its action, its delay, and the copy it sends. Take the campaignId from heyreach_campaigns. Use this when asked what a campaign says or how it is structured.",
    input_schema: {
      type: "object",
      properties: { ...CLIENT_ARG, campaignId: { type: "string", description: "HeyReach campaign id." } },
      required: ["client", "campaignId"],
    },
  },
  {
    name: "heyreach_lists",
    description:
      "The lead lists in one client's HeyReach account: name, whether it holds people or companies, how many are on it, when it was built, and which campaigns use it. Use this for questions about audience size or where a campaign's leads came from.",
    input_schema: { type: "object", properties: { ...CLIENT_ARG }, required: ["client"] },
  },
  {
    name: "heyreach_export_list",
    description:
      "Download one client's HeyReach lead list as a CSV file. Returns everyone on the list with their name, job title, company, location, LinkedIn URL and email where HeyReach has one. Identify the list by listId from heyreach_lists, or by listName and it will be matched. IMPORTANT: the file is built here and delivered to the browser directly — the rows are deliberately not returned to you, so do not attempt to reproduce, summarise row-by-row or re-tabulate them. Report what was exported, how many rows it has, and that it is ready to download. Use this whenever someone asks to export, download or get a list, an audience or a set of leads as a spreadsheet. To narrow a list — a file you already delivered, or a new one — call this again for the same list with titleContains, companyContains or nameContains. That is the ONLY way to filter an exported list, because you never held its rows; it re-fetches from HeyReach, filters there, and delivers a second file. Never tell someone a delivered list cannot be filtered.",
    input_schema: {
      type: "object",
      properties: {
        ...CLIENT_ARG,
        listId: { type: "string", description: "HeyReach list id, from heyreach_lists." },
        listName: { type: "string", description: "Part of the list's name, if you do not have its id." },
        limit: { type: "integer", description: `How many people, up to ${EXPORT_ROWS}. Defaults to the whole list.` },
        titleContains: {
          type: "array",
          items: { type: "string" },
          description:
            "Keep only people whose job title contains any of these. Titles are free text, so pass every spelling — for chief executives, [\"CEO\", \"Chief Executive\", \"Founder\"]. Ignored for company lists.",
        },
        companyContains: {
          type: "array",
          items: { type: "string" },
          description: "Keep only rows whose company name contains any of these.",
        },
        nameContains: {
          type: "array",
          items: { type: "string" },
          description: "Keep only rows whose person or company name contains any of these.",
        },
      },
      required: ["client"],
    },
  },
  {
    name: "heyreach_workspace_totals",
    description:
      "One client's account-wide totals from HeyReach, optionally over a date window: connections sent and accepted, messages sent, conversations started, replies, unique leads contacted, and leads tagged interested. This is the only place unique leads contacted is available — HeyReach does not report it per campaign. Use it for 'how is this client doing overall'. Note this covers the client's entire HeyReach account, so it includes any campaigns they ran before hiring QC; heyreach_campaign_metrics is the QC-only view.",
    input_schema: { type: "object", properties: { ...CLIENT_ARG, ...WINDOW_ARGS }, required: ["client"] },
  },
  {
    name: "heyreach_inbox_search",
    description:
      "One client's live LinkedIn inbox in HeyReach, with the full message threads. Filter by person's name, by campaign, or to unread only. Unlike recent_replies this is HeyReach's own inbox rather than Reply Radar's database, so it includes conversations Reply Radar has not ingested — use it to check something Reply Radar may have missed, or to read a thread as LinkedIn actually has it. IMPORTANT: HeyReach cannot search message text. nameContains matches the person's name only, so never conclude from an empty result that nobody mentioned a topic.",
    input_schema: {
      type: "object",
      properties: {
        ...CLIENT_ARG,
        nameContains: { type: "string", description: "Part of the person's name. Matches their name only, not what they wrote." },
        campaignIds: { type: "array", items: { type: "string" }, description: "Restrict to these HeyReach campaign ids." },
        unreadOnly: { type: "boolean", description: "Only conversations nobody has opened yet." },
        limit: { type: "integer", description: `How many, up to ${MAX_THREADS}. Default 10. Lower than the other list tools because each conversation carries its whole message thread.` },
      },
      required: ["client"],
    },
  },
  {
    name: "heyreach_person_profile",
    description:
      "Everything HeyReach knows about one person by LinkedIn profile URL, for one client: their profile details, the tags on them including HeyReach's own 'interested' auto-tag, and every lead list they appear on. Use this alongside find_person when a question is about one individual.",
    input_schema: {
      type: "object",
      properties: { ...CLIENT_ARG, profileUrl: { type: "string", description: "Their LinkedIn profile URL." } },
      required: ["client", "profileUrl"],
    },
  },
  {
    name: "brain_search",
    description:
      "Search the QC Brain — the shared GitHub repository holding every client's ICP, personas, tone of voice, engagement plan and call notes, plus QC's own playbooks and vertical research. This is the tool for any question about strategy, positioning, who a client sells to, what we decided, or why a campaign is written the way it is. Reply Radar's other tools know what happened; the brain knows what we intended. Returns the best-matching files with a snippet and the path to read in full. Every word in the query must appear in a file for it to match, so keep queries to two or three words.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Two or three words, e.g. \"willow icp\" or \"security vertical\". Longer phrases narrow to nothing." },
        client: { type: "string", description: "Optional: restrict to one client's folder, e.g. \"willow\"." },
        limit: { type: "integer", description: "How many files, up to 20. Default 8." },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_read",
    description:
      "Read one file from the QC Brain in full, by its path. Call brain_search or brain_client first to find the path — guessing one wastes a call. Also returns the SHA needed by brain_write, so read a file before proposing a change to it.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repository path, e.g. \"clients/willow/account/icp.md\"." } },
      required: ["path"],
    },
  },
  {
    name: "brain_client",
    description:
      "One client's shape in the QC Brain: which of the standard documents exist (brief, ICP, personas, voice, engagement, pipeline, do-not-contact), which are missing, and every other file we hold on them. Call this to orient before reading, and to answer \"what do we know about X\" or \"what is missing for X\". With no client named, returns every client in the brain.",
    input_schema: {
      type: "object",
      properties: { client: { type: "string", description: "Folder name or client name, e.g. \"willow\" or \"Bluevia Health\". Omit for the full list." } },
    },
  },
  {
    name: "brain_write",
    description:
      "Propose a change to a markdown file in the QC Brain. This does NOT save anything — it opens a pull request that a person must review and merge, and it returns that pull request's URL. Say so plainly when you report back; never tell someone their file has been updated. Pass the file's full new text, not a diff or a fragment: whatever is passed becomes the entire file, so read it with brain_read first and return the complete document with your change made. Pass the sha brain_read gave you, which is what stops you overwriting an edit somebody made in the meantime; omit it only when creating a file that does not exist yet.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path ending in .md, e.g. \"clients/willow/account/icp.md\"." },
        text: { type: "string", description: "The complete new contents of the file. Not a diff. Not just the changed section." },
        summary: { type: "string", description: "One line saying what changed and why. Becomes the pull request title, so write it for the person reviewing it." },
        sha: { type: "string", description: "The sha from brain_read. Omit only when the file does not exist yet." },
      },
      required: ["path", "text", "summary"],
    },
  },
  {
    name: "brain_skills",
    description:
      "The routines QC has already written down: the slash commands in the QC Brain, like /willow-weekly or /account-research. Each one is a set of instructions somebody worked out once so nobody has to work it out again. Call with no arguments to list them all with a line each. Call with a name to get that skill's full instructions, which you should then carry out yourself using your other tools — the instructions are for you to follow, not to show to the person. Check here first whenever someone asks for a report, a research pass, a weekly summary or anything that sounds like a routine, because doing it QC's established way is almost always better than inventing a way.",
    input_schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "The command to fetch in full, with or without the slash, e.g. \"willow-weekly\" or \"/account-research\". Omit to list every skill." },
        client: { type: "string", description: "Optional: when listing, restrict to skills belonging to one client, e.g. \"willow\"." },
      },
    },
  },
  {
    name: "airtable_tables",
    description:
      "The tables in one client's Airtable base, each with its fields: the field name, its type, and — for single-select and status fields — the exact set of options it allows. This is QC's own working record for the client: campaign trackers, project and action items, weekly call recaps, and whatever else that base has grown. ALWAYS call this before reading rows from or writing to a table, because field names and select options differ between clients and a write to a name or option that does not exist is rejected. Addressed by client only; there is no base id to pass. One shared base is also reachable by name and is not a client: pass client: \"Client Template\" to read or write QC's onboarding template base.",
    input_schema: { type: "object", properties: { ...CLIENT_ARG }, required: ["client"] },
  },
  {
    name: "airtable_records",
    description:
      "Read rows from one table in a client's Airtable base. Returns each row's record id and its fields, plus the total number of rows in the table so you can say whether the list is complete. Identify the table by the name or id from airtable_tables. Use this to answer what is in a tracker, to find a row before updating it, or to check whether something is already recorded. The record id it returns is what airtable_update_records needs to change a row.",
    input_schema: {
      type: "object",
      properties: {
        ...CLIENT_ARG,
        table: { type: "string", description: "Table name or id, from airtable_tables." },
        limit: { type: "integer", description: `How many rows to return, up to ${AIRTABLE_READ_ROWS}. Default ${AIRTABLE_READ_ROWS}. The total row count is returned regardless.` },
      },
      required: ["client", "table"],
    },
  },
  {
    name: "airtable_create_records",
    description:
      "Add one or more rows to a table in a client's Airtable base. This writes immediately and cannot be undone through this assistant, so read the table with airtable_tables first, use the exact field names and — for select fields — the exact options it lists, and show the person what you are about to add before you do it. Each record is an object of field name to value. Returns the created rows with their new record ids. Use this when someone asks to add, log, record or file something in a client's Airtable.",
    input_schema: {
      type: "object",
      properties: {
        ...CLIENT_ARG,
        table: { type: "string", description: "Table name or id, from airtable_tables." },
        records: {
          type: "array",
          description: `The rows to add, each an object mapping field name to value. Up to ${AIRTABLE_WRITE_ROWS} at once. Field names must match the table exactly.`,
          items: { type: "object" },
        },
      },
      required: ["client", "table", "records"],
    },
  },
  {
    name: "airtable_update_records",
    description:
      "Change fields on existing rows in a client's Airtable base. This writes immediately and cannot be undone through this assistant. You must identify each row by its record id, which you get from airtable_records — never guess an id, and if you cannot find the row, say so rather than creating a duplicate with airtable_create_records. Only the fields you pass are changed; the rest of the row is untouched. Use the exact field names and select options from airtable_tables. Returns the updated rows. There is deliberately no way to delete a row here — that is done by hand in Airtable.",
    input_schema: {
      type: "object",
      properties: {
        ...CLIENT_ARG,
        table: { type: "string", description: "Table name or id, from airtable_tables." },
        records: {
          type: "array",
          description: `The rows to change, each { id, fields }, where id is the record id from airtable_records and fields maps field name to new value. Up to ${AIRTABLE_WRITE_ROWS} at once.`,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The record id from airtable_records." },
              fields: { type: "object", description: "Field name to new value. Only these fields change." },
            },
            required: ["id", "fields"],
          },
        },
      },
      required: ["client", "table", "records"],
    },
  },
  {
    name: "slack_channels",
    description:
      "The Slack channels QC has configured for each client in Reply Radar: the internal (team) channel, the external (client-facing) channel, and any extras. Pass a client to get just theirs, or omit to list every client's. Returns each channel's id and its Slack name — a null name means the channel could not be read, which usually means the reading token is not a member of it. Use this to see what can be scanned and to get the id to hand slack_scan.",
    input_schema: { type: "object", properties: { client: { type: "string", description: "Optional client name or slug. Omit to list every client's channels." } } },
  },
  {
    name: "slack_scan",
    description:
      "Read the messages in one of a client's configured Slack channels — threads walked, not just the parent messages — so you can answer what was said, find where something was decided, or summarise the channel. By default it reads the last `days` (30 if unset); pass full: true to read all the way back to the channel's creation. Messages come back oldest first, with real names and timestamps. Choose the channel with `channel`: \"internal\" (default), \"external\", or a channel id from slack_channels. A channel longer than the message cap is returned from its most recent stretch and says so — pass a specific `days` for an older window.",
    input_schema: {
      type: "object",
      properties: {
        ...CLIENT_ARG,
        channel: { type: "string", description: "\"internal\" (default), \"external\", or a channel id from slack_channels." },
        days: { type: "integer", description: `How many days back to read. Default ${SLACK_SCAN_DEFAULT_DAYS}. Ignored when full is true.` },
        full: { type: "boolean", description: "Read all the way back to the channel's creation instead of the last `days`." },
        limit: { type: "integer", description: `Most messages to return, up to ${SLACK_SCAN_MAX}. Default ${SLACK_SCAN_DEFAULT}, or ${SLACK_SCAN_FULL_DEFAULT} for a full scan.` },
      },
      required: ["client"],
    },
  },
  {
    name: "add_meeting",
    description:
      "Record a booked meeting for a client — use this when a reply, a Slack message, or a call recap makes clear a meeting was actually booked. Give the client and whatever you have: who booked (name, email, title, LinkedIn, company), when it is (ISO 8601), what it is about, who it is with on our side, and which campaign it came from. Missing fields are fine; an invitee name, email or company is the minimum. Most clients' Calendly files these automatically through a webhook, so only add one here for a booking that route would not catch — and tell the person you are recording it, so you are not duplicating a meeting they can already see.",
    input_schema: {
      type: "object",
      properties: {
        ...CLIENT_ARG,
        invitee_name: { type: "string", description: "Who booked the meeting." },
        invitee_email: { type: "string" },
        invitee_title: { type: "string" },
        invitee_linkedin: { type: "string" },
        company_name: { type: "string", description: "The invitee's company." },
        meeting_at: { type: "string", description: "When the meeting is, ISO 8601 if you can, e.g. 2026-08-19T14:00:00Z. Leave out if unknown." },
        summary: { type: "string", description: "What the meeting is, e.g. \"Steadywell Intro\"." },
        host: { type: "string", description: "Who it is with on our side, e.g. \"Josh & Tim\"." },
        campaign: { type: "string", description: "The campaign it came from, if known." },
      },
      required: ["client"],
    },
  },
];

/* ── Dispatch ────────────────────────────────────────────────────────────────────────────────── */

/** HeyReach rates are 0–1 fractions; one decimal place of a percent is what a person reads. */
const percent = (fraction: number) => Math.round(fraction * 1000) / 10;

/**
 * Runs one tool and returns whatever the model should see.
 *
 * Throwing is fine and expected — the route turns an error into a tool result the model can read and
 * recover from, which is how "there is no client called Willo" becomes a follow-up question rather
 * than a failed request.
 */
export async function runTool(name: string, input: Row): Promise<unknown> {
  switch (name) {
    case "list_clients": {
      const all = await clients();
      return all.map(({ apiKey, id, ...rest }) => ({ ...rest, heyreachConnected: Boolean(apiKey), id }));
    }

    case "client_summary": {
      const client = await resolveClient(input.client);
      const rows_ = rows(
        await db(`rr_workspaces?select=client_brief,custom_system_prompt&id=eq.${encodeURIComponent(client.id)}&limit=1`),
      );
      const brief = text(rows_[0]?.client_brief);
      const voice = text(rows_[0]?.custom_system_prompt);
      return {
        client: client.name,
        slug: client.slug,
        configured: Boolean(brief || voice),
        summary: brief || null,
        voice: voice || null,
        // Said out loud rather than left as an empty string, because "no briefing" and "a briefing
        // that says nothing useful" call for different answers and the model cannot tell them apart.
        note: brief || voice
          ? undefined
          : "Nobody has filled in this client's briefing yet. Say so rather than inferring what they sell — the /client-summary command in the QC Growth OS generates it and it is pasted into the client's AI configuration.",
      };
    }

    case "database_totals": {
      const { url, key } = supabase();
      const since = text(input.since);
      const until = text(input.until);
      const window = `${since ? `&sent_at=gte.${encodeURIComponent(since)}` : ""}${until ? `&sent_at=lt.${encodeURIComponent(until)}` : ""}`;
      const [leads, conversations, repliesAllTime, repliesInWindow, clientCount] = await Promise.all([
        countRows(url, key, "rr_leads?select=id"),
        countRows(url, key, "rr_conversations?select=id"),
        countRows(url, key, "rr_messages?select=id&direction=eq.inbound"),
        since || until
          ? countRows(url, key, `rr_messages?select=id&direction=eq.inbound${window}`)
          : Promise.resolve(null),
        countRows(url, key, "rr_workspaces?select=id"),
      ]);
      return {
        leads,
        conversations,
        repliesAllTime,
        ...(repliesInWindow === null ? {} : { repliesInWindow, window: { since, until } }),
        clients: clientCount,
        note: "Counted across every client in Reply Radar's database. Not per client.",
      };
    }

    case "recent_replies": {
      const client = text(input.client) ? await resolveClient(input.client) : null;
      const items = await conversationsFor(client, {
        order: "last_message_at.desc",
        limit: rowLimit(input.limit, 15),
        since: text(input.since) || undefined,
      });
      return { client: client?.name ?? "all clients", count: items.length, conversations: items };
    }

    case "awaiting_reply": {
      const client = text(input.client) ? await resolveClient(input.client) : null;
      const items = await conversationsFor(client, {
        order: "last_message_at.asc",
        limit: rowLimit(input.limit, 25),
        awaitingUs: true,
      });
      return {
        client: client?.name ?? "all clients",
        count: items.length,
        note: "Oldest wait first. The lead sent the last message in each of these.",
        conversations: items,
      };
    }

    case "find_person": {
      const query = text(input.query);
      if (!query) throw new Error("Give a name or a LinkedIn profile URL.");
      const filter = /linkedin\.com/i.test(query)
        ? `linkedin_profile_url=ilike.*${encodeURIComponent(query.replace(/^https?:\/\//i, "").replace(/\/$/, ""))}*`
        : `name=ilike.*${encodeURIComponent(query)}*`;
      const leadRows = rows(
        await db(`rr_leads?select=id,name,role,company,linkedin_profile_url,workspace_id&${filter}&limit=${MAX_ROWS}`),
      );
      if (!leadRows.length) return { found: 0, note: `Nobody in the database matches "${query}".` };
      const all = await clients();
      const clientById = new Map(all.map((c) => [c.id, c.name]));
      const leadIds = leadRows.map((row) => text(row.id)).filter(Boolean);
      const conversationRows = await dbByIds(
        (batch) =>
          `rr_conversations?select=id,lead_id,workspace_id,last_message_at,last_message_direction&lead_id=in.(${batch.join(",")})&order=last_message_at.desc&limit=${MAX_ROWS}`,
        leadIds,
      );
      const described = await describeConversations(conversationRows);
      const byLead = new Map<string, Row[]>();
      conversationRows.forEach((row, index) => {
        const key = text(row.lead_id);
        byLead.set(key, [...(byLead.get(key) ?? []), described[index]]);
      });
      return {
        found: leadRows.length,
        people: leadRows.map((row) => ({
          name: text(row.name),
          role: text(row.role),
          company: text(row.company),
          profileUrl: text(row.linkedin_profile_url),
          client: clientById.get(text(row.workspace_id)) ?? "",
          conversations: byLead.get(text(row.id)) ?? [],
        })),
      };
    }

    case "search_leads": {
      const conditions = [
        containsAny("role", input.role),
        containsAny("company", input.company),
        containsAny("name", input.name),
      ].filter(Boolean);
      if (!conditions.length) throw new Error("Give at least one of role, company or name to search for.");
      const client = text(input.client) ? await resolveClient(input.client) : null;
      const filters = [
        `and=(${conditions.join(",")})`,
        client ? `workspace_id=eq.${encodeURIComponent(client.id)}` : "",
      ]
        .filter(Boolean)
        .join("&");

      const limit = rowLimit(input.limit, 100);
      const { url, key } = supabase();
      // The count is asked for separately and without the limit, so an answer can say "312 people
      // match, here are the first 300" instead of presenting a capped list as the whole population.
      const [leadRows, total] = await Promise.all([
        db(`rr_leads?select=id,name,role,company,linkedin_profile_url,workspace_id,raw_data&${filters}&order=created_at.desc&limit=${limit}`).then(rows),
        countRows(url, key, `rr_leads?select=id&${filters}`),
      ]);
      if (!leadRows.length) {
        return {
          matched: 0,
          note: "Nobody in the database matches that. Titles are free text as people wrote them on LinkedIn, so try more spellings — the acronym and the words behind it — or a shorter fragment before concluding there are none.",
        };
      }

      const all = await clients();
      const clientById = new Map(all.map((entry) => [entry.id, entry.name]));
      const leadIds = leadRows.map((row) => text(row.id)).filter(Boolean);
      // Just the conversation rows, not `describeConversations` — that pulls every message body for
      // every thread, which for three hundred people is the whole inbox. A list of people needs to
      // know who replied and how they scored, not what they said; read_conversation is for that.
      const conversationRows = await dbByIds(
        (batch) =>
          `rr_conversations?select=id,lead_id,last_message_at,last_message_direction&lead_id=in.(${batch.join(",")})&order=last_message_at.desc`,
        leadIds,
      );
      const newest = new Map<string, Row>();
      for (const row of conversationRows) {
        const key = text(row.lead_id);
        if (!newest.has(key)) newest.set(key, row);
      }

      const people = leadRows
        .map((row) => {
          const conversation = newest.get(text(row.id));
          const icp = judgement(row).icp_score;
          return {
            name: text(row.name),
            role: text(row.role),
            company: text(row.company),
            profileUrl: text(row.linkedin_profile_url),
            client: clientById.get(text(row.workspace_id)) ?? "",
            replied: Boolean(conversation),
            conversationId: conversation ? text(conversation.id) : null,
            lastMessageAt: conversation ? text(conversation.last_message_at) : null,
            awaitingUs: conversation ? text(conversation.last_message_direction) === "inbound" : false,
            leadScore: icp === undefined || icp === null ? null : Number(icp) || 0,
          };
        })
        .filter((person) => (input.repliedOnly === true ? person.replied : true));

      // PostgREST can decline to give a count. Reporting `matched` as null then is deliberate: the
      // model must not be able to read a missing total as "no more than what you see".
      const capped = total === null ? leadRows.length === limit : total > leadRows.length;
      return {
        matched: total,
        returned: people.length,
        client: client?.name ?? "all clients",
        ...(capped
          ? {
              note: `${total === null ? "More" : `${total} people match, and more`} than the ${leadRows.length} listed here; these are the most recently added. Raise limit for the rest.`,
            }
          : {}),
        people,
      };
    }

    case "read_conversation": {
      const id = text(input.conversationId);
      if (!id) throw new Error("A conversationId is required.");
      const messageRows = rows(
        await db(
          `rr_messages?select=direction,body,sent_at&conversation_id=eq.${encodeURIComponent(id)}&order=sent_at.asc&limit=200`,
        ),
      );
      return {
        conversationId: id,
        messageCount: messageRows.length,
        messages: messageRows.map((row) => ({
          from: text(row.direction) === "inbound" ? "lead" : "us",
          sentAt: text(row.sent_at),
          body: text(row.body),
        })),
      };
    }

    case "heyreach_campaigns": {
      const client = await connectedClient(input.client);
      const status = await campaignStatusFor(client.apiKey);
      if (!status.available) throw new Error(`HeyReach could not be reached for ${client.name}: ${status.reason}`);
      const describe = (row: (typeof status.active)[number]) => ({
        id: row.id,
        name: row.name,
        heyreachStatus: row.status,
        launchedAt: row.launchedAt,
        listSize: row.progress.listSize,
        pendingLeads: row.progress.pending,
        contacted: row.progress.contacted,
        senders: row.senders,
        senderNames: row.senderNames,
        daysOfSendingLeft: row.daysLeftInSending,
      });
      return {
        client: client.name,
        note: "Active means running AND still contacting new leads. Worked through means HeyReach says in progress but the list is exhausted, which is finished in every sense the client cares about.",
        active: status.active.map(describe),
        workedThrough: status.workedThrough.map(describe),
        scheduled: status.scheduled.map(describe),
        paused: status.paused.map(describe),
      };
    }

    case "heyreach_campaign_metrics": {
      const client = await connectedClient(input.client);
      const since = text(input.since);
      const until = text(input.until);
      if (Boolean(since) !== Boolean(until)) {
        throw new Error("HeyReach needs both since and until, or neither. One alone is rejected.");
      }
      const all = await heyreach.statsByCampaign(client.apiKey, { startDate: since || undefined, endDate: until || undefined });
      const ours = all.filter((row) => isOurCampaign(row.campaignName) && !row.deleted);
      return {
        client: client.name,
        window: since ? { since, until } : "all time",
        note: "Only campaigns QC launched. Rates are percentages, already converted.",
        rateWarning:
          "replyRatePercent and acceptanceRatePercent are HeyReach's own figures and their denominators are not documented — on a live account the reply rate did not reconcile exactly against replies ÷ messagesSent. Report them as HeyReach's rates. Do not describe either as a share of conversationsStarted, messagesSent or leads contacted, and do not place them in a table column beside a count that implies a denominator. To rank by a rate you can defend, divide two of the raw counts below yourself and name them.",
        campaigns: ours.map((row) => ({
          id: row.campaignId,
          name: row.campaignName,
          connectionsSent: row.connectionsSent,
          connectionsAccepted: row.connectionsAccepted,
          acceptanceRatePercent: percent(row.connectionAcceptanceRate),
          messagesSent: row.messagesSent,
          conversationsStarted: row.conversationsStarted,
          replies: row.messageReplies,
          replyRatePercent: percent(row.messageReplyRate),
          // `leadsContacted` is deliberately absent. HeyReach returns zero for it on every campaign
          // row — including one that had sent 881 connection requests — and only fills it in on the
          // workspace total. Passing that zero through would have the assistant reporting that a
          // working campaign contacted nobody. `connectionsSent` is the number that answers it.
          taggedInterested: row.taggedInterested,
        })),
      };
    }

    case "heyreach_senders": {
      const client = await connectedClient(input.client);
      const page = await heyreach.senders(client.apiKey);
      return {
        client: client.name,
        note: "An account that is active but whose LinkedIn session is invalid sends nothing without erroring.",
        senders: page.items.map((row) => ({
          id: row.id,
          name: row.name,
          profileUrl: row.profileUrl,
          switchedOn: row.active,
          linkedInSessionValid: row.authValid,
          activeCampaigns: row.activeCampaigns,
        })),
      };
    }

    case "heyreach_person_campaigns": {
      const client = await connectedClient(input.client);
      const profileUrl = text(input.profileUrl);
      if (!profileUrl) throw new Error("A LinkedIn profile URL is required.");
      const page = await heyreach.campaignsForLead(client.apiKey, { profileUrl });
      const ours = page.items.filter((row) => isOurCampaign(row.name));
      return {
        client: client.name,
        profileUrl,
        enrolledIn: ours.map((row) => ({ id: row.id, name: row.name, status: row.status, startedAt: row.startedAt })),
        ...(ours.length ? {} : { note: "Not enrolled in any campaign QC launched for this client." }),
      };
    }

    case "heyreach_campaign_sequence": {
      const client = await connectedClient(input.client);
      const campaignId = text(input.campaignId);
      if (!campaignId) throw new Error("A campaignId is required.");
      return { client: client.name, campaignId, sequence: await heyreach.campaignSequence(client.apiKey, campaignId) };
    }

    case "heyreach_lists": {
      const client = await connectedClient(input.client);
      const page = await heyreach.lists(client.apiKey);
      return {
        client: client.name,
        total: page.total,
        lists: page.items.map((row) => ({
          id: row.id,
          name: row.name,
          holds: row.type === "COMPANY_LIST" ? "companies" : "people",
          size: row.size,
          createdAt: row.createdAt,
          usedByCampaigns: row.campaignIds.length,
        })),
      };
    }

    case "heyreach_export_list": {
      const client = await connectedClient(input.client);
      const wanted = text(input.listName);
      const listId = text(input.listId);
      const all = await heyreach.lists(client.apiKey);
      // Resolved here rather than trusted, because an id the model half-remembered from an earlier
      // turn would otherwise export the wrong client's audience with no sign that anything was wrong.
      let chosen = all.items.find((row) => row.id === listId);
      if (!chosen && wanted) {
        const needle = wanted.toLowerCase();
        const matched = all.items.filter((row) => row.name.toLowerCase().includes(needle));
        if (matched.length > 1) {
          throw new Error(
            `Several of ${client.name}'s lists match "${wanted}": ${matched.map((row) => `${row.name} (${row.id})`).join(", ")}. Give listId.`,
          );
        }
        chosen = matched[0];
      }
      if (!chosen) {
        throw new Error(
          `No such list. ${client.name}'s lists are: ${all.items.map((row) => `${row.name} (${row.id})`).join(", ") || "none"}.`,
        );
      }

      const cap = rowLimit(input.limit, EXPORT_ROWS, EXPORT_ROWS);
      const companies = chosen.type === "COMPANY_LIST";
      const page = companies
        ? await heyreach.companiesInList(client.apiKey, chosen.id, cap)
        : await heyreach.leadsInList(client.apiKey, chosen.id, cap);

      const head = companies
        ? ["Company", "Industry", "Location", "Employees", "Website", "LinkedIn"]
        : ["Name", "Job title", "Company", "Location", "LinkedIn", "Email"];
      const everyone = page.items.map((row) =>
        companies
          ? [text(row.name) || text(row.companyName), text(row.industry), text(row.location), text(row.companySize), text(row.website), text(row.linkedInUrl) || text(row.profileUrl)]
          : [
              [text(row.firstName), text(row.lastName)].filter(Boolean).join(" ") || text(row.fullName),
              text(row.position) || text(row.headline) || text(row.summary),
              text(row.companyName) || text(row.company),
              text(row.location),
              text(row.profileUrl) || text(row.linkedInUrl),
              text(row.emailAddress) || text(row.email),
            ],
      );

      /**
       * Narrowing happens here rather than in the answer, and that is the whole point.
       *
       * Someone gets a list of 218 and asks to see only the CEOs. The obvious move — filter the file
       * we just sent — is impossible by design, because the rows were never returned to the model.
       * The honest alternative is to go back to HeyReach and export a smaller file, which is what
       * this does. It costs one more request and produces a file with the same provenance as the
       * first, instead of a table the model typed out from memory it does not have.
       *
       * Matching is case-insensitive substring against any of the terms given, the same rule as
       * search_leads, and for the same reason: a job title is whatever the person typed on LinkedIn.
       */
      const filters: Array<{ label: string; column: number; terms: string[] }> = [
        { label: "title", column: 1, terms: strings(input.titleContains) },
        { label: "company", column: 2, terms: strings(input.companyContains) },
        { label: "name", column: 0, terms: strings(input.nameContains) },
      ].filter((rule) => rule.terms.length > 0);

      const grid = filters.length
        ? everyone.filter((row) =>
            filters.every((rule) => {
              const field = String(row[rule.column] ?? "").toLowerCase();
              return rule.terms.some((term) => field.includes(term.toLowerCase()));
            }),
          )
        : everyone;

      const narrowed = filters.map((rule) => `${rule.label}: ${rule.terms.join(", ")}`).join("; ");
      // The filter goes in the filename so a narrowed export does not land in the Downloads folder
      // looking exactly like the full one it came from.
      const label = [client.name, chosen.name, filters.flatMap((rule) => rule.terms).join(" ")]
        .filter(Boolean)
        .join(" ");

      if (filters.length && !grid.length) {
        throw new Error(
          `Nothing on ${chosen.name} matches ${narrowed}. ${everyone.length} rows were searched. Job titles are free text — try more spellings, or ask for the whole list.`,
        );
      }

      return {
        client: client.name,
        list: chosen.name,
        listId: chosen.id,
        holds: companies ? "companies" : "people",
        onList: chosen.size,
        searched: everyone.length,
        filteredBy: narrowed || "nothing — this is the whole list",
        exported: grid.length,
        // Said explicitly, because a list capped at the ceiling looks complete in the file and the
        // person forwarding it has no other way to find out that it is not.
        complete: everyone.length >= chosen.size || everyone.length < cap,
        columns: head,
        delivered: "The CSV has been sent to the browser and is ready to download beneath your answer. Its rows are not available to you — say what was exported and how many, and do not list the people. Do not add an export block: the file already exists.",
        [FILE_KEY]: {
          name: exportFilename(label, "", "csv"),
          mime: "text/csv;charset=utf-8",
          content: rowsToCsv(head, grid),
        } satisfies ToolFile,
      };
    }

    case "heyreach_workspace_totals": {
      const client = await connectedClient(input.client);
      const since = text(input.since);
      const until = text(input.until);
      if (Boolean(since) !== Boolean(until)) {
        throw new Error("HeyReach needs both since and until, or neither. One alone is rejected.");
      }
      const stats = await heyreach.overallStats(client.apiKey, {
        startDate: since || undefined,
        endDate: until || undefined,
      });
      return {
        client: client.name,
        window: since ? { since, until } : "all time",
        note: "The client's whole HeyReach account, including any campaigns they ran before hiring QC. Rates are percentages.",
        rateWarning:
          "replyRatePercent and acceptanceRatePercent are HeyReach's own figures with undocumented denominators. Quote them as HeyReach's rates, or divide the raw counts yourself and say which two you used.",
        connectionsSent: stats.connectionsSent,
        connectionsAccepted: stats.connectionsAccepted,
        acceptanceRatePercent: percent(stats.connectionAcceptanceRate),
        messagesSent: stats.messagesSent,
        conversationsStarted: stats.conversationsStarted,
        replies: stats.messageReplies,
        replyRatePercent: percent(stats.messageReplyRate),
        uniqueLeadsContacted: stats.leadsContacted,
        taggedInterested: stats.taggedInterested,
      };
    }

    case "heyreach_inbox_search": {
      const client = await connectedClient(input.client);
      const page = await heyreach.conversations(
        client.apiKey,
        {
          // Exposed to the model as `nameContains` because HeyReach's `searchString` matches the
          // person's name and nothing else. Named for what it does, a model cannot reach for it to
          // find out who mentioned pricing and read the empty result as "nobody did".
          searchString: text(input.nameContains) || undefined,
          campaignIds: Array.isArray(input.campaignIds) ? input.campaignIds.map(text).filter(Boolean) : undefined,
          // `seen: false` is the unread filter. Absent entirely when not asked for, because
          // `seen: true` is a filter for *read* conversations, not the absence of one.
          ...(input.unreadOnly === true ? { seen: false } : {}),
        },
        rowLimit(input.limit, 10, MAX_THREADS),
      );
      return {
        client: client.name,
        matched: page.total,
        showing: page.items.length,
        conversations: page.items.map((row) => ({
          leadName: row.leadName,
          profileUrl: row.leadProfileUrl,
          sender: row.senderName,
          lastMessageAt: row.lastMessageAt,
          lastMessageFrom: row.lastMessageFrom,
          read: row.read,
          messageCount: row.messageCount,
          // The whole thread, because it arrives with the conversation anyway and this tool exists
          // for the questions our own database cannot answer — truncating it here would waste the call.
          messages: row.messages.map((message) => ({ ...message, body: message.body.slice(0, 800) })),
        })),
      };
    }

    case "heyreach_person_profile": {
      const client = await connectedClient(input.client);
      const profileUrl = text(input.profileUrl);
      if (!profileUrl) throw new Error("A LinkedIn profile URL is required.");
      const [profile, tags, memberships] = await Promise.all([
        heyreach.lead(client.apiKey, profileUrl),
        heyreach.leadTags(client.apiKey, profileUrl).catch(() => ({})),
        heyreach.listsForLead(client.apiKey, { profileUrl }).catch(() => ({ items: [], total: 0 })),
      ]);
      return {
        client: client.name,
        profileUrl,
        profile,
        tags,
        lists: memberships.items.map((row) => ({ id: row.id, name: row.name, size: row.size })),
      };
    }

    case "brain_search": {
      const query = text(input.query);
      if (!query) throw new Error("A search query is required.");
      const only = text(input.client).toLowerCase();
      const tree = await brainTree();
      const paths = tree
        .map((file) => file.path)
        .filter((path) => isReadable(path))
        // Filtering the paths rather than the results, because the corpus is cached whole and the
        // scoped search should still be one pass over it.
        .filter((path) => !only || String(clientOf(path)).toLowerCase() === only);
      if (!paths.length) {
        return { query, client: only, results: [], note: only ? `There is no client folder called "${only}" in the brain.` : "" };
      }
      const docs = (await brainCorpus(tree.map((file) => file.path).filter((path) => isReadable(path))))
        .filter((doc) => paths.includes(doc.path))
        .map((doc) => ({ ...doc, title: String(fileTitle(doc.path)) }));
      const wanted = Math.min(Math.max(Number(input.limit) || 8, 1), 20);
      const results = (searchBrain(docs, query, wanted) as { path: string; title: string; snippet: string }[]).map((hit) => ({
        path: hit.path,
        title: hit.title,
        client: String(clientLabel(clientOf(hit.path))),
        snippet: hit.snippet,
        url: `${BRAIN_URL}/blob/main/${hit.path}`,
      }));
      return {
        query,
        results,
        // Said out loud because an empty result from a three-word query means the words were too
        // specific, not that the brain has nothing on the subject.
        note: results.length ? "Call brain_read with a path to see any of these in full." : "Nothing matched every word. Try fewer, more common words.",
      };
    }

    case "brain_read": {
      const path = text(input.path);
      if (!path) throw new Error("A file path is required.");
      if (path.includes("..") || path.startsWith("/")) throw new Error("That is not a path inside the brain.");
      if (!isReadable(path)) {
        return { path, readable: false, kind: String(fileKind(path)), url: `${BRAIN_URL}/blob/main/${path}`, note: "That file is not text. Link to it rather than quoting it." };
      }
      const doc = await brainFile(path);
      return {
        path,
        title: String(fileTitle(path)),
        client: String(clientLabel(clientOf(path))),
        sha: doc.sha,
        url: doc.url,
        text: doc.text,
      };
    }

    case "brain_client": {
      const tree = await brainTree();
      const paths = tree.map((file) => file.path);
      const all = clientsIn(paths) as string[];
      const asked = text(input.client);
      if (!asked) {
        return { clients: all.map((folder) => ({ folder, name: String(clientLabel(folder)) })) };
      }
      const wanted = asked.toLowerCase();
      // A person says "Bluevia Health"; the repo says `bluevia-health`. Both have to land.
      const folder = all.find((one) => one.toLowerCase() === wanted || String(clientLabel(one)).toLowerCase() === wanted);
      if (!folder) {
        throw new Error(`There is no client called "${asked}" in the brain. The clients are: ${all.map((one) => clientLabel(one)).join(", ")}.`);
      }
      const skeleton = clientSkeleton(folder, paths) as {
        docs: { key: string; label: string; found: string; present: boolean }[];
        extras: string[];
      };
      return {
        client: String(clientLabel(folder)),
        folder,
        documents: skeleton.docs.map((doc) => ({ name: doc.label, path: doc.found, written: doc.present })),
        // Named separately from the skeleton because "we have never written their ICP" is usually the
        // most important fact on this response, and a model reading a list of paths will not notice it.
        missing: skeleton.docs.filter((doc) => !doc.present).map((doc) => doc.label),
        otherFiles: skeleton.extras,
      };
    }

    case "brain_write": {
      if (!brainConfigured()) throw new Error("The QC Brain is not connected, so nothing can be proposed.");
      const path = text(input.path);
      const body = typeof input.text === "string" ? input.text : "";
      const summary = text(input.summary);
      if (!path || path.includes("..") || path.startsWith("/")) throw new Error("That is not a path inside the brain.");
      if (fileKind(path) !== "doc") throw new Error("Only markdown files can be proposed through here.");
      if (!summary) throw new Error("A one-line summary is required — it becomes the pull request title.");
      // An empty body would be a deletion dressed up as an edit, and a model that lost its place
      // mid-thought is far likelier than someone genuinely asking to empty a file.
      if (!body.trim()) throw new Error("The new contents are empty. Deleting a file is done in GitHub, deliberately.");
      const pull = await proposeBrainEdit({ path, text: body, sha: text(input.sha), summary, author: "Reply Radar MCP" });
      forgetBrainTree();
      return {
        proposed: true,
        saved: false,
        path,
        pullRequest: pull.url,
        number: pull.number,
        branch: pull.branch,
        note: "This is a pull request, not a saved change. Give the person the link and tell them it needs merging before anyone else's Claude Code will see it.",
      };
    }

    /**
     * The skills, and the reason the chat has them at all.
     *
     * A skill is a prompt somebody wrote once — the steps for a weekly client report, an account
     * research pass — and until now the only way to run one was to type it into Claude Code. But the
     * instructions are just markdown, and this assistant has the same tools those instructions
     * assume. So listing them and handing back the body is the whole implementation: the model reads
     * the steps and carries them out, exactly as Claude Code does.
     *
     * The body is returned to the model, not to the person. A skill is a set of instructions, and
     * printing the instructions instead of following them is the obvious failure here, so the note
     * says so where the model cannot miss it.
     */
    case "brain_skills": {
      if (!brainConfigured()) throw new Error("The QC Brain is not connected, so its skills cannot be read.");
      const tree = await brainTree();
      const paths = tree.map((file) => file.path);
      const clients = clientsIn(paths) as string[];
      const commandPaths = paths.filter((path) => path.startsWith(COMMANDS) && path.endsWith(".md"));

      const wanted = text(input.skill).replace(/^\//, "").replace(/\.md$/i, "").toLowerCase();
      if (wanted) {
        const found = commandPaths.find((path) => (path.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase() === wanted);
        if (!found) {
          const names = commandPaths.map((path) => `/${(path.split("/").pop() ?? "").replace(/\.md$/i, "")}`);
          throw new Error(`There is no skill called "${wanted}". The skills are: ${names.join(", ")}.`);
        }
        const doc = await brainFile(found);
        const parsed = parseSkill(doc.path, doc.text) as { name: string; command: string; blurb: string };
        return {
          skill: parsed.command,
          name: parsed.name,
          path: doc.path,
          instructions: doc.text,
          note: "These are instructions for you to follow, not text to show the person. Carry out the steps yourself with your other tools, and if a step needs something you cannot do, say which step and why.",
        };
      }

      const docs = await brainFiles(commandPaths, 8);
      const only = text(input.client).toLowerCase();
      const skills = docs
        .map((doc) => {
          const parsed = parseSkill(doc.path, doc.text) as { name: string; command: string; blurb: string };
          const owner = String(skillClient(parsed.name, clients) ?? "");
          return { command: parsed.command, does: parsed.blurb, client: owner ? String(clientLabel(owner)) : "", folder: owner };
        })
        .filter((skill) => !only || skill.folder.toLowerCase() === only || skill.client.toLowerCase() === only)
        .sort((a, b) => a.command.localeCompare(b.command));

      return {
        // The folder was only ever there to match `client=willow` against; the model gets the label.
        skills: skills.map((skill) => ({ command: skill.command, does: skill.does, client: skill.client })),
        note: "Call brain_skills again with a skill name to get its full instructions, then carry them out yourself.",
      };
    }

    case "airtable_tables": {
      const { client, baseId } = await airtableBaseFor(input.client);
      const tables = airtableData(await getBaseTables(baseId));
      return {
        client: client.name,
        note: "Field names and select options differ per client. Use the exact names below when reading or writing, and one of the listed options for a select field.",
        tables: tables.map((table) => ({
          id: table.id,
          name: table.name,
          fields: (table.fields ?? []).map((field) => ({
            name: field.name,
            type: field.type,
            // Only present for the select-style fields, where writing anything off the list is refused.
            ...(field.options?.choices?.length
              ? { options: field.options.choices.map((choice) => choice.name).filter(Boolean) }
              : {}),
          })),
        })),
      };
    }

    case "airtable_records": {
      const { client, baseId } = await airtableBaseFor(input.client);
      const tables = airtableData(await getBaseTables(baseId));
      const table = resolveAirtableTable(tables, input.table);
      const all = airtableData(await airtableList(baseId, table.id));
      const limit = rowLimit(input.limit, AIRTABLE_READ_ROWS, AIRTABLE_READ_ROWS);
      const shown = all.slice(0, limit);
      return {
        client: client.name,
        table: table.name,
        total: all.length,
        returned: shown.length,
        ...(all.length > shown.length
          ? { note: `${all.length} rows in total; showing the first ${shown.length}. Raise limit for more.` }
          : {}),
        records: shown.map((record) => ({ id: record.id, fields: record.fields })),
      };
    }

    case "airtable_create_records": {
      const { client, baseId } = await airtableBaseFor(input.client);
      const tables = airtableData(await getBaseTables(baseId));
      const table = resolveAirtableTable(tables, input.table);
      const incoming = rows(input.records);
      if (!incoming.length) throw new Error("Give at least one record to create, each an object of field name to value.");
      if (incoming.length > AIRTABLE_WRITE_ROWS) {
        throw new Error(`That is ${incoming.length} records at once; the ceiling is ${AIRTABLE_WRITE_ROWS}. Split it into smaller writes.`);
      }
      const payload = incoming.map((record) => checkFields(table, record));
      const created = airtableData(await airtableCreate(baseId, table.id, payload));
      return {
        client: client.name,
        table: table.name,
        created: created.length,
        note: "Written to Airtable. This is a real, immediate change — say what was added and give the record ids.",
        records: created.map((record) => ({ id: record.id, fields: record.fields })),
      };
    }

    case "airtable_update_records": {
      const { client, baseId } = await airtableBaseFor(input.client);
      const tables = airtableData(await getBaseTables(baseId));
      const table = resolveAirtableTable(tables, input.table);
      const incoming = rows(input.records);
      if (!incoming.length) throw new Error("Give at least one record to update, each { id, fields }.");
      if (incoming.length > AIRTABLE_WRITE_ROWS) {
        throw new Error(`That is ${incoming.length} records at once; the ceiling is ${AIRTABLE_WRITE_ROWS}. Split it into smaller writes.`);
      }
      const payload = incoming.map((record) => {
        const id = text(record.id);
        if (!id) throw new Error("Every update needs the row's record id, from airtable_records. Never guess one.");
        return { id, fields: checkFields(table, object(record.fields)) };
      });
      const updated = airtableData(await airtableUpdate(baseId, table.id, payload));
      return {
        client: client.name,
        table: table.name,
        updated: updated.length,
        note: "Written to Airtable. This is a real, immediate change — say which rows changed and to what.",
        records: updated.map((record) => ({ id: record.id, fields: record.fields })),
      };
    }

    case "slack_channels": {
      if (!slackReadable()) throw new Error("Slack reading is not configured — neither a Slack user nor bot token is set.");
      const select = "name,slug,slack_internal_channel_id,slack_external_channel_id,slack_extra_channel_ids";
      const rows_ = text(input.client).trim()
        ? rows(await db(`rr_workspaces?select=${select}&id=eq.${encodeURIComponent((await resolveClient(input.client)).id)}&limit=1`))
        : rows(await db(`rr_workspaces?select=${select}&order=name.asc`));
      const extrasOf = (row: Row) => (Array.isArray(row.slack_extra_channel_ids) ? row.slack_extra_channel_ids : []).map((entry) => text(entry)).filter(Boolean);
      const ids = new Set<string>();
      for (const row of rows_) {
        for (const id of [text(row.slack_internal_channel_id), text(row.slack_external_channel_id), ...extrasOf(row)]) if (id) ids.add(id);
      }
      const names = await resolveChannelNames([...ids]);
      const entryFor = (id: string) => (id ? { id, name: names.get(id) ?? null } : null);
      const clients = rows_
        .map((row) => ({
          client: text(row.name),
          internal: entryFor(text(row.slack_internal_channel_id)),
          external: entryFor(text(row.slack_external_channel_id)),
          extras: extrasOf(row).map((id) => entryFor(id)).filter(Boolean),
        }))
        .filter((entry) => entry.internal || entry.external || entry.extras.length);
      return {
        note: "A channel with a null name could not be read — usually the reading token is not a member of it. Pass any id here to slack_scan, or \"internal\"/\"external\" with the client.",
        clients,
      };
    }

    case "slack_scan": {
      if (!slackReadable()) throw new Error("Slack reading is not configured — neither a Slack user nor bot token is set.");
      const client = await resolveClient(input.client);
      const ws = rows(await db(`rr_workspaces?select=slack_internal_channel_id,slack_external_channel_id&id=eq.${encodeURIComponent(client.id)}&limit=1`))[0] ?? {};
      const choice = text(input.channel).trim().toLowerCase() || "internal";
      let channelId = "";
      if (choice === "internal") channelId = text(ws.slack_internal_channel_id);
      else if (choice === "external") channelId = text(ws.slack_external_channel_id);
      else channelId = normalizeChannelId(text(input.channel));
      if (!channelId) {
        throw new Error(
          choice === "internal" || choice === "external"
            ? `${client.name} has no ${choice} Slack channel configured. Set it on their configuration page, or pass a channel id from slack_channels.`
            : `"${text(input.channel)}" is not a channel. Use "internal", "external", or a channel id from slack_channels.`,
        );
      }
      const full = input.full === true;
      const days = full ? 0 : Math.max(1, Math.min(365, Math.floor(Number(input.days)) || SLACK_SCAN_DEFAULT_DAYS));
      const cap = Math.max(1, Math.min(SLACK_SCAN_MAX, Math.floor(Number(input.limit)) || (full ? SLACK_SCAN_FULL_DEFAULT : SLACK_SCAN_DEFAULT)));
      const scan = await scanChannel(channelId, { days, maxMessages: cap });
      const [names, channelNames] = await Promise.all([
        resolveUserNames(scan.messages.map((message) => message.author)),
        resolveChannelNames([channelId]),
      ]);
      const body = transcript(scan.messages, names, client.timezone);
      return {
        client: client.name,
        channel: channelNames.get(channelId) ?? channelId,
        scope: full ? "full history, back to the channel's creation" : `last ${days} days`,
        messages: scan.messages.length,
        threads: scan.threads,
        ...(full && !scan.reachedStart
          ? { truncated: true, note: `This channel is longer than the ${cap}-message cap, so this is its most recent ${scan.messages.length} messages, not the whole history. Ask for an earlier window with days, or raise limit (max ${SLACK_SCAN_MAX}).` }
          : {}),
        transcript: body || "No messages in that window.",
      };
    }

    case "add_meeting": {
      const client = await resolveClient(input.client);
      const fields = {
        invitee_name: text(input.invitee_name),
        invitee_email: text(input.invitee_email),
        invitee_title: text(input.invitee_title),
        invitee_linkedin: text(input.invitee_linkedin),
        company_name: text(input.company_name),
        meeting_at: text(input.meeting_at) || null,
        summary: text(input.summary),
        host: text(input.host),
        campaign: text(input.campaign),
        raw: input,
      };
      const result = await addMeeting(client.slug, fields, "assistant");
      if (!result.ok) throw new Error(result.error);
      return {
        client: client.name,
        note: "Recorded in the client's Meetings. Tell the person it was added, and do not add the same meeting twice.",
        meeting: result.meeting,
      };
    }

    default:
      throw new Error(`There is no tool called "${name}".`);
  }
}
