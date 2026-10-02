// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A small in-memory PostgREST for the analytics routes, plus JS mirrors of the two analytics SQL
 * functions (`supabase/migrations/20261002_rr_analytics_overview.sql`).
 *
 * It implements just what those routes send: `select=` with aliases and JSON paths (`->`, `->>`),
 * `eq`/`neq`/`in` filters, multi-column `order`, `limit`/`offset` with PostgREST's 1,000-row ceiling,
 * `Prefer: count=exact`, and `rpc/<name>`. Timestamps are compared at microsecond precision, as
 * Postgres does, so the routes' millisecond truncation is exercised rather than assumed.
 */

export const SUPABASE = "https://supabase.test";
const MAX_ROWS = 1000;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Microseconds since the epoch of a Postgres-style timestamp string, as a BigInt. */
export function micros(value) {
  const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(String(value));
  if (!match) throw new Error(`bad timestamp ${value}`);
  const whole = Date.parse(`${match[1]}${match[3]}`);
  const fraction = (match[2] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(whole) * 1000n + BigInt(fraction);
}

/** `->` on a jsonb value: objects by key, anything else (arrays included, for a text key) is null. */
const arrow = (value, key) => (value && typeof value === "object" && !Array.isArray(value) && key in value ? value[key] : null);
/** `->>`: the same, as text. */
const arrowText = (value, key) => {
  const found = arrow(value, key);
  if (found === null || found === undefined) return null;
  return typeof found === "string" ? found : JSON.stringify(found);
};

function project(row, select) {
  if (!select || select === "*") return { ...row };
  const out = {};
  for (const item of select.split(",")) {
    const [alias, expression] = item.includes(":") ? item.split(":") : [null, item];
    const parts = expression.split(/(->>|->)/);
    const column = parts[0];
    let value = row[column];
    for (let index = 1; index < parts.length; index += 2) {
      value = parts[index] === "->>" ? arrowText(value, parts[index + 1]) : arrow(value, parts[index + 1]);
    }
    out[alias ?? (parts.length > 1 ? parts.at(-1) : column)] = value === undefined ? null : value;
  }
  return out;
}

const compareValues = (column, a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (column === "sent_at" || column === "launched_at" || column === "started_at") {
    const left = micros(a);
    const right = micros(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return String(a) < String(b) ? -1 : 1;
};

function readTable(rows, query, headers) {
  const params = new URLSearchParams(query);
  let result = rows.filter((row) => {
    for (const [column, condition] of params) {
      if (["select", "order", "limit", "offset"].includes(column)) continue;
      const [operator, ...rest] = condition.split(".");
      const operand = rest.join(".");
      const value = row[column];
      if (operator === "eq" && String(value) !== operand) return false;
      if (operator === "neq" && String(value) === operand) return false;
      if (operator === "gte" && !(String(value) >= operand)) return false;
      if (operator === "in" && !operand.replace(/^\(|\)$/g, "").split(",").includes(String(value))) return false;
    }
    return true;
  });
  const order = params.get("order");
  if (order) {
    const keys = order.split(",").map((part) => {
      const [column, direction] = part.split(".");
      return { column, descending: direction === "desc" };
    });
    result = [...result].sort((a, b) => {
      for (const { column, descending } of keys) {
        const compared = compareValues(column, a[column], b[column]);
        if (compared) return descending ? -compared : compared;
      }
      return 0;
    });
  }
  const total = result.length;
  const offset = Number(params.get("offset") ?? 0);
  const limit = Math.min(MAX_ROWS, Number(params.get("limit") ?? MAX_ROWS));
  const page = result.slice(offset, offset + limit).map((row) => project(row, params.get("select")));
  const extra = /count=exact/.test(String(headers?.Prefer ?? headers?.prefer ?? ""))
    ? { "content-range": `${page.length ? `${offset}-${offset + page.length - 1}` : "*"}/${total}` }
    : {};
  return json(page, 200, extra);
}

const NEW_YORK_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** JS mirror of `rr_analytics_overview`, statement by statement. */
export function overviewRpc(db, { p_workspace_ids, p_week_ago, p_trend_since }) {
  const wsBatch = new Map(p_workspace_ids.map((id, index) => [id, Math.floor(index / 20)]));
  const conv = db.rr_conversations
    .filter((row) => wsBatch.has(row.workspace_id))
    .sort((a, b) => wsBatch.get(a.workspace_id) - wsBatch.get(b.workspace_id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row, index) => ({ ...row, conv_rank: index + 1 }));
  const convById = new Map(conv.map((row) => [row.id, row]));
  const msg = db.rr_messages.filter((row) => convById.has(row.conversation_id)).map((row) => {
    const c = convById.get(row.conversation_id);
    const radar = arrow(row.raw_data, "reply_radar");
    return {
      id: row.id, conversation_id: row.conversation_id, direction: row.direction, sent_at: row.sent_at, us: micros(row.sent_at),
      workspace_id: c.workspace_id, conv_batch: Math.floor((c.conv_rank - 1) / 20),
      campaign: arrow(arrow(radar, "campaign"), "name"), sender: arrow(arrow(radar, "sender"), "name"), sentiment: arrow(radar, "sentiment"),
    };
  });
  const bySeq = [...msg].sort((a, b) => a.conv_batch - b.conv_batch || (a.us < b.us ? -1 : a.us > b.us ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const weekAgo = micros(p_week_ago);
  const trendSince = micros(p_trend_since);
  const grouped = new Map();
  bySeq.forEach((row, seq) => {
    const sentiment = row.direction === "inbound" ? row.sentiment : null;
    const recent = row.direction === "inbound" && row.us >= weekAgo;
    const key = JSON.stringify([row.workspace_id, row.direction, row.campaign, row.sender, sentiment, recent]);
    const group = grouped.get(key) ?? { workspace_id: row.workspace_id, direction: row.direction, campaign: row.campaign, sender: row.sender, sentiment, recent, n: 0, first_seq: seq };
    group.n += 1;
    grouped.set(key, group);
  });
  const threads = new Map();
  for (const row of msg.filter((m) => m.direction === "inbound" || m.direction === "outbound")) {
    threads.set(row.conversation_id, [...(threads.get(row.conversation_id) ?? []), row]);
  }
  let sum = 0n;
  let n = 0;
  for (const thread of threads.values()) {
    thread.sort((a, b) => (a.us < b.us ? -1 : a.us > b.us ? 1 : 0) || (a.id < b.id ? -1 : 1));
    thread.forEach((row, index) => {
      const previous = thread[index - 1];
      if (row.direction !== "inbound" || previous?.direction !== "outbound") return;
      const ms = row.us / 1000n;
      const previousMs = previous.us / 1000n;
      if (previousMs !== 0n && ms >= previousMs) { sum += ms - previousMs; n += 1; }
    });
  }
  const days = {};
  for (const row of msg) {
    if (row.direction !== "inbound" || row.us < trendSince) continue;
    const day = NEW_YORK_DAY.format(new Date(Number(row.us / 1000n)));
    days[day] = (days[day] ?? 0) + 1;
  }
  const tiers = new Map();
  for (const row of conv) {
    const key = JSON.stringify([row.workspace_id, row.tier ?? null]);
    const group = tiers.get(key) ?? { workspace_id: row.workspace_id, tier: row.tier ?? null, n: 0 };
    group.n += 1;
    tiers.set(key, group);
  }
  return {
    conversations: [...tiers.values()],
    messages: [...grouped.values()].sort((a, b) => a.first_seq - b.first_seq),
    inbound_by_day: days,
    response: { sum_ms: Number(sum), n },
  };
}

/** JS mirror of `rr_analytics_client_replies`. */
export function clientRepliesRpc(db, { p_workspace_id, p_week_ago }) {
  const conv = new Set(db.rr_conversations.filter((row) => row.workspace_id === p_workspace_id).map((row) => row.id));
  const weekAgo = micros(p_week_ago);
  const groups = new Map();
  for (const row of db.rr_messages) {
    if (!conv.has(row.conversation_id) || row.direction !== "inbound") continue;
    const radar = arrow(row.raw_data, "reply_radar");
    const campaign = arrowText(arrow(radar, "campaign"), "name");
    const sentiment = arrowText(radar, "sentiment");
    const recent = micros(row.sent_at) >= weekAgo;
    const key = JSON.stringify([campaign, sentiment, recent]);
    const group = groups.get(key) ?? { campaign, sentiment, recent, n: 0 };
    group.n += 1;
    groups.set(key, group);
  }
  return { conversations: conv.size, groups: [...groups.values()] };
}

/**
 * A `fetch` that answers from `db`. `rpc: false` makes the functions 404 as on a database without the
 * migration. HeyReach is answered from `db.heyreach` so campaign metrics have something to join.
 */
export function fakeFetch(db, { rpc = true, calls = [] } = {}) {
  return async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://api.heyreach.io/")) {
      const apiKey = init.headers?.["X-API-KEY"];
      const data = db.heyreach[apiKey] ?? { stats: [], campaigns: [] };
      if (url.endsWith("/GetOverallStatsByCampaign")) return json({ overallStats: data.stats });
      const { offset, limit } = JSON.parse(init.body);
      return json({ items: data.campaigns.slice(offset, offset + limit), totalCount: data.campaigns.length });
    }
    if (!url.startsWith(`${SUPABASE}/rest/v1/`)) throw new Error(`Unexpected external call: ${url}`);
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("rpc/")) {
      if (!rpc) return json({ code: "PGRST202", message: "function not found" }, 404);
      const args = JSON.parse(init.body);
      if (path === "rpc/rr_analytics_overview") return json(overviewRpc(db, args));
      if (path === "rpc/rr_analytics_client_replies") return json(clientRepliesRpc(db, args));
      return json({}, 404);
    }
    if ((init.method ?? "GET") !== "GET") return new Response(null, { status: 201 });
    const [table, query = ""] = path.split("?");
    const rows = db[table];
    if (!rows) return json([]);
    return readTable(rows, query, init.headers);
  };
}

/** A deterministic pseudo-random generator, so the fixture is the same on every run. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const uuid = (prefix, index) => `${prefix}${String(index).padStart(7, "0")}-0000-4000-8000-${String(index * 7919 % 1e12).padStart(12, "0")}`;

/**
 * Three clients (plus `misc`, which the route leaves out), over 1,000 conversations in one of them so
 * the conversation read pages, a thread long enough that a 20-conversation message batch pages, ties
 * on `sent_at`, microsecond timestamps, every shape of attribution the old code tolerated, and a
 * direction that is neither inbound nor outbound.
 */
export function buildFixture(now) {
  const next = random(42);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const workspaces = [
    { id: "a0000000-0000-4000-8000-000000000001", name: "Bluevia", slug: "bluevia", heyreach_api_key_ciphertext: "key-bluevia", logo_url: null, accent_color: "#123456" },
    { id: "a0000000-0000-4000-8000-000000000002", name: "Willow", slug: "willow", heyreach_api_key_ciphertext: "key-willow", logo_url: null, accent_color: null },
    { id: "a0000000-0000-4000-8000-000000000003", name: "Cotool", slug: "cotool", heyreach_api_key_ciphertext: "", logo_url: null, accent_color: null },
    { id: "a0000000-0000-4000-8000-000000000004", name: "Misc", slug: "misc", heyreach_api_key_ciphertext: "", logo_url: null, accent_color: null },
  ];
  const campaigns = ["BV001: Founders", "BV002: Ops leaders", "WL001: Clinics", "WL002: Dental ", "CT001: Devtools"];
  const senders = ["Ana", "Ben", "Cleo", "Dev"];
  const conversations = [];
  const counts = [1150, 240, 60, 5];
  workspaces.forEach((workspace, w) => {
    for (let index = 0; index < counts[w]; index += 1) {
      conversations.push({ id: uuid(`c${w}`, Math.floor(next() * 9_000_000)), workspace_id: workspace.id, tier: pick(["hot", "warm", "nurture", "HOT", "", null, "cold"]), score: 50 });
    }
  });
  const unique = [...new Map(conversations.map((row) => [row.id, row])).values()];
  const attributionShapes = [
    () => ({ reply_radar: { campaign: { name: pick(campaigns) }, sender: { name: pick(senders) }, sentiment: pick(["positive", "Positive", "negative", "neutral", null]) } }),
    () => ({ reply_radar: { campaign: { name: pick(campaigns) }, sentiment: "positive" } }),
    () => ({ reply_radar: { campaign: { name: null }, sender: { name: pick(senders) } } }),
    () => ({ reply_radar: { campaign: { name: "" }, sentiment: "POSITIVE" } }),
    () => ({ reply_radar: { campaign: "not an object" } }),
    () => ({ reply_radar: [1, 2] }),
    () => ({ other: true }),
    () => ({}),
  ];
  const messages = [];
  let messageIndex = 0;
  const nowMs = now;
  for (const conversation of unique) {
    const length = conversation === unique[3] ? 1200 : 1 + Math.floor(next() * 4);
    let at = nowMs - Math.floor(next() * 20 * 86_400_000);
    for (let index = 0; index < length; index += 1) {
      // Mostly advancing; sometimes the very same instant as the previous message, so `id` decides.
      if (next() > 0.15) at += Math.floor(next() * 6 * 3_600_000);
      const microseconds = String(Math.floor(next() * 1_000_000)).padStart(6, "0");
      const sentAt = `${new Date(at).toISOString().slice(0, 19)}.${microseconds}+00:00`;
      const direction = next() < 0.03 ? "system" : next() < 0.5 ? "outbound" : "inbound";
      messages.push({
        id: uuid("e", messageIndex += 1 + Math.floor(next() * 3)),
        conversation_id: conversation.id, direction, sent_at: sentAt, body: "x".repeat(40),
        raw_data: pick(attributionShapes)(),
      });
    }
  }
  const stats = (names) => names.map((name, index) => ({
    campaignId: 100 + index, campaignName: name, connectionsSent: 400 + index * 37, connectionsAccepted: 120 + index * 11,
    connectionAcceptanceRate: index % 2 ? 0.31 : "", totalMessageReplies: 20 + index, totalInmailReplies: index, totalMessageStarted: 90, totalInmailStarted: 2,
  }));
  return {
    rr_workspaces: workspaces,
    rr_conversations: unique,
    rr_messages: messages,
    rr_campaign_stats: workspaces.flatMap((workspace) => campaigns.map((name, index) => ({
      workspace_id: workspace.id, campaign_id: String(index), name, status: "IN_PROGRESS", launched_at: `2026-0${1 + index}-01T00:00:00+00:00`,
      sender_ids: ["1", "2"], total_leads: 500, leads_pending: 40 * index, connections_sent: 300, connections_accepted: 90, replies: 30,
      refreshed_at: "2026-10-01T10:00:00+00:00",
    }))),
    rr_daily_stats: [],
    rr_sync_runs: [],
    heyreach: {
      "key-bluevia": { stats: stats(campaigns.slice(0, 2).concat(["Client's own test"])), campaigns: campaigns.slice(0, 2).map((name, index) => ({ id: 100 + index, name, startedAt: "2026-05-01T00:00:00Z", status: "IN_PROGRESS" })) },
      "key-willow": { stats: stats(["WL001: Clinics", "WL002: Dental"]), campaigns: [{ id: 100, name: "WL001: Clinics", startedAt: "2026-06-01T00:00:00Z", status: "PAUSED" }] },
    },
  };
}
