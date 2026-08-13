/**
 * The tools the assistant is allowed to use, and the code that runs them.
 *
 * This is the whole of what the chat box can do. Claude receives the definitions below, asks for one
 * by name, and `runTool` answers — there is no path from a typed question to anything not listed
 * here. That is the security model: not an instruction telling the model to behave, but an allowlist
 * with no write operation in it. Adding a tool is a deliberate act; a cleverly worded prompt is not.
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
 * - **Reply content, scores, tiers and who is waiting on us** come from our tables, because HeyReach
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
import { countRows } from "./rest-count";
import { isOurCampaign } from "../../shared/campaign-code.mjs";
import * as heyreach from "./heyreach-api";

type Row = Record<string, unknown>;

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(object) : []);
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

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

/* ── Conversations, enriched with the person behind them ─────────────────────────────────────── */

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
      (batch) => `rr_leads?select=id,name,role,company,linkedin_profile_url,workspace_id&id=in.(${batch.join(",")})`,
      leadIds,
    ),
    // Every message for these conversations, not just the newest: PostgREST has no per-group limit, so
    // the newest is picked out below. Deliberately unbounded — a row cap here would drop whole
    // conversations' messages rather than trimming each one, and a blank last reply looks like data.
    dbByIds(
      (batch) =>
        `rr_messages?select=conversation_id,direction,body,sent_at&conversation_id=in.(${batch.join(",")})&order=sent_at.desc`,
      ids,
    ),
  ]);
  const leadById = new Map(rows(leadRows).map((row) => [text(row.id), row]));
  // Only the most recent message per conversation. The rest is what `read_conversation` is for, and
  // returning whole threads here would flood the context with sequences the question never asked about.
  const latest = new Map<string, Row>();
  for (const message of rows(messageRows)) {
    const key = text(message.conversation_id);
    if (!latest.has(key)) latest.set(key, message);
  }

  return conversationRows.map((row) => {
    const lead = leadById.get(text(row.lead_id)) ?? {};
    const message = latest.get(text(row.id)) ?? {};
    return {
      conversationId: text(row.id),
      name: text(lead.name),
      role: text(lead.role),
      company: text(lead.company),
      profileUrl: text(lead.linkedin_profile_url),
      lastMessageAt: text(row.last_message_at),
      lastMessageFrom: text(row.last_message_direction) === "inbound" ? "lead" : "us",
      lastMessage: text(message.body).slice(0, 600),
      score: row.score ?? null,
      tier: text(row.tier) || null,
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
  const path = `rr_conversations?select=id,lead_id,workspace_id,last_message_at,last_message_direction,score,tier${filters.length ? `&${filters.join("&")}` : ""}&order=${order}&limit=${limit}`;
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

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_clients",
    description:
      "Every client workspace in Reply Radar: name, slug, time zone, when they were added, and whether a HeyReach key is connected. Call this first when a question names a client you have not yet resolved, or asks how many clients there are.",
    input_schema: { type: "object", properties: {} },
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
      "The most recent conversations, newest first, with the lead's name, role, company, LinkedIn URL, their latest message, and Reply Radar's score and tier. Optionally scoped to one client. This is the tool for 'what came in', 'show me recent replies', or any question about what people actually said.",
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
      "Find someone by name or LinkedIn profile URL across every client. Returns which client they belong to, their role and company, and each conversation with them including score and tier. Use this when a question names a person.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "A person's name, or their LinkedIn profile URL." } },
      required: ["query"],
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
          `rr_conversations?select=id,lead_id,workspace_id,last_message_at,last_message_direction,score,tier&lead_id=in.(${batch.join(",")})&order=last_message_at.desc&limit=${MAX_ROWS}`,
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

    default:
      throw new Error(`There is no tool called "${name}".`);
  }
}
