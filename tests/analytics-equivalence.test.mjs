// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The analytics speed-up must not move a single number.
 *
 * `/api/analytics` used to page every conversation and every message (raw_data and all) and count them
 * in the function. It now either asks Postgres for the counts (`rr_analytics_overview`) or, without that
 * function, reads slimmer rows and groups them before counting. Both paths are run here against the same
 * fake database and compared, field for field, with the old algorithm — kept below verbatim as the
 * oracle, reading the same fake database the old way.
 *
 * The fixture is built to hit the places the outputs could quietly diverge: paging past 1,000 rows,
 * ties in the top-12 rankings (decided by which campaign was seen first), the order of each campaign's
 * client list, microsecond timestamps against a millisecond week boundary, New York day buckets, and
 * attribution JSON in every shape the old code tolerated.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { SUPABASE, buildFixture, fakeFetch } from "./fixtures/analytics-fake-supabase.mjs";
import { ourCampaigns } from "../shared/campaign-code.mjs";

const nextServerStub = `data:text/javascript,${encodeURIComponent("export const NextResponse = { json: (body, init) => Response.json(body, init) };")}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return { url: nextServerStub, shortCircuit: true };
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

process.env.SUPABASE_URL = SUPABASE;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";

const NOW = Date.parse("2026-10-02T16:00:00Z");
const db = buildFixture(NOW);

/* ----------------------------------------------------------------------------------------------- */
/* The old route's computation, unchanged apart from taking `get` instead of reaching for `fetch`. */
/* ----------------------------------------------------------------------------------------------- */

async function legacyAnalytics(get, requested = []) {
  const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const attribution = (row) => {
    const radar = object(object(row.raw_data).reply_radar);
    return { campaign: String(object(radar.campaign).name ?? "Unattributed campaign"), sender: String(object(radar.sender).name ?? "Unknown sender") };
  };
  const supabaseAll = async (path, pageSize = 1000) => {
    const all = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let offset = 0; ; offset += pageSize) {
      const page = await get(`${path}${separator}limit=${pageSize}&offset=${offset}`);
      if (!page || page.length === 0) break;
      all.push(...page);
      if (page.length < pageSize) break;
    }
    return all;
  };
  const queryByIds = async (ids, size, run) => {
    const batches = [];
    for (let index = 0; index < ids.length; index += size) batches.push(ids.slice(index, index + size));
    return (await Promise.all(batches.map(run))).flat();
  };
  const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const easternDayKey = (date) => dayKeyFormat.format(date);
  const shiftDayKey = (key, days) => new Date(Date.parse(`${key}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const heyReach = async (apiKey, path, body) => {
    const response = await fetch(`https://api.heyreach.io/api/public/${path}`, { method: "POST", headers: { "X-API-KEY": apiKey }, body: JSON.stringify(body) });
    return response.json();
  };

  const workspaces = await get("rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext,logo_url,accent_color&slug=neq.misc&order=name.asc") ?? [];
  const selected = requested.length ? workspaces.filter((row) => requested.includes(String(row.slug))) : workspaces;
  const ids = selected.map((row) => String(row.id));
  const filter = (batch) => batch.map(encodeURIComponent).join(",");
  const conversations = await queryByIds(ids, 20, async (batch) =>
    (await supabaseAll(`rr_conversations?select=id,workspace_id,score,tier,last_message_at,created_at&workspace_id=in.(${filter(batch)})&order=id.asc`)) ?? []);
  const conversationIdList = conversations.map((row) => String(row.id)).filter(Boolean);
  const messages = await queryByIds(conversationIdList, 20, async (batch) =>
    (await supabaseAll(`rr_messages?select=conversation_id,direction,sent_at,raw_data&conversation_id=in.(${filter(batch)})&order=sent_at.asc,id.asc`)) ?? []);
  const campaignResponses = await Promise.all(selected.map(async (workspace) => {
    const apiKey = String(workspace.heyreach_api_key_ciphertext ?? "").trim();
    const rows = apiKey ? ourCampaigns((await heyReach(apiKey, "stats/GetOverallStatsByCampaign", {})).overallStats ?? [], (row) => row.campaignName) : [];
    const list = apiKey ? ourCampaigns((await heyReach(apiKey, "campaign/GetAll", { offset: 0, limit: 100 })).items ?? [], (row) => row.name) : [];
    const launchById = new Map();
    const launchByName = new Map();
    for (const item of list) {
      launchById.set(String(item.id), item);
      launchByName.set(String(item.name ?? "").trim().toLowerCase(), item);
    }
    return { workspace, rows, launchById, launchByName };
  }));
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const inbound = messages.filter((row) => row.direction === "inbound");
  const outbound = messages.filter((row) => row.direction === "outbound");
  const recentMessages = inbound.filter((row) => new Date(String(row.sent_at)).getTime() >= weekAgo);
  const todayKey = easternDayKey(new Date(now));
  const trendDays = Array.from({ length: 14 }, (_, index) => shiftDayKey(todayKey, index - 13));
  const inboundByDay = new Map();
  for (const row of inbound) {
    const sentAt = new Date(String(row.sent_at));
    if (Number.isNaN(sentAt.getTime())) continue;
    const key = easternDayKey(sentAt);
    inboundByDay.set(key, (inboundByDay.get(key) ?? 0) + 1);
  }
  const trend = trendDays.map((key) => inboundByDay.get(key) ?? 0);
  const trendLabels = trendDays.map((key) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`);
  const completeDays = trend.slice(-8, -1);
  const averageDailyReplies = completeDays.length ? completeDays.reduce((sum, value) => sum + value, 0) / completeDays.length : 0;
  const queueMix = conversations.reduce((result, row) => {
    const tier = String(row.tier || "nurture").toLowerCase();
    if (tier === "hot" || tier === "warm" || tier === "nurture") result[tier] += 1;
    return result;
  }, { hot: 0, warm: 0, nurture: 0 });
  const clientLoad = selected.map((workspace) => ({ name: workspace.name, leads: conversations.filter((row) => row.workspace_id === workspace.id).length }));
  const conversationWorkspace = new Map(conversations.map((row) => [String(row.id), String(row.workspace_id)]));
  const workspaceName = new Map(selected.map((row) => [String(row.id), String(row.name)]));
  const clientPerformance = selected.map((workspace) => {
    const conversationIds = new Set(conversations.filter((row) => row.workspace_id === workspace.id).map((row) => String(row.id)));
    const clientMessages = messages.filter((row) => conversationIds.has(String(row.conversation_id)));
    return { name: workspace.name, conversations: conversationIds.size, replies: clientMessages.filter((row) => row.direction === "inbound").length, messagesSent: clientMessages.filter((row) => row.direction === "outbound").length };
  }).sort((a, b) => b.replies - a.replies);
  const groupPerformance = (key) => {
    const groups = new Map();
    for (const message of messages) {
      const name = attribution(message)[key];
      const group = groups.get(name) ?? { name, replies: 0, messages: 0, clients: new Set() };
      group.messages += 1;
      if (message.direction === "inbound") group.replies += 1;
      group.clients.add(workspaceName.get(conversationWorkspace.get(String(message.conversation_id)) ?? "") ?? "Unknown client");
      groups.set(name, group);
    }
    return [...groups.values()].map((group) => ({ ...group, clients: [...group.clients] })).sort((a, b) => b.replies - a.replies).slice(0, 12);
  };
  const responseTimes = [];
  const byConversation = new Map();
  for (const message of messages) byConversation.set(String(message.conversation_id), [...(byConversation.get(String(message.conversation_id)) ?? []), message]);
  for (const thread of byConversation.values()) {
    let lastOutbound = 0;
    for (const message of thread) {
      const timestamp = new Date(String(message.sent_at)).getTime();
      if (message.direction === "outbound") lastOutbound = timestamp;
      else if (message.direction === "inbound" && lastOutbound && timestamp >= lastOutbound) { responseTimes.push(timestamp - lastOutbound); lastOutbound = 0; }
    }
  }
  const averageResponseMinutes = responseTimes.length ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length / 60_000) : null;
  const positiveByCampaign = new Map();
  const positiveSets = new Map();
  const recentByCampaign = new Map();
  for (const message of inbound) {
    const radar = object(object(message.raw_data).reply_radar);
    const name = String(object(radar.campaign).name ?? "");
    if (!name) continue;
    const workspaceId = conversationWorkspace.get(String(message.conversation_id)) ?? "";
    const key = `${workspaceId}:${name}`;
    // Positive leads, not positive messages (one lead with three positive messages is one).
    if (String(radar.sentiment ?? "").toLowerCase() === "positive") {
      const leads = positiveSets.get(key) ?? new Set();
      leads.add(String(message.conversation_id));
      positiveSets.set(key, leads);
    }
    if (new Date(String(message.sent_at)).getTime() >= weekAgo) recentByCampaign.set(key, (recentByCampaign.get(key) ?? 0) + 1);
  }
  for (const [key, leads] of positiveSets) positiveByCampaign.set(key, leads.size);
  const campaignMetrics = campaignResponses.flatMap(({ workspace, rows, launchById, launchByName }) => rows.map((row) => {
    const accepted = Number(row.connectionsAccepted ?? 0);
    const replies = Number(row.totalMessageReplies ?? 0) + Number(row.totalInmailReplies ?? 0);
    const name = String(row.campaignName ?? `Campaign ${row.campaignId ?? ""}`).trim();
    const positiveReplies = positiveByCampaign.get(`${String(workspace.id)}:${name}`) ?? 0;
    const replies7d = recentByCampaign.get(`${String(workspace.id)}:${name}`) ?? 0;
    const hasProviderAcceptanceRate = row.connectionAcceptanceRate !== null && row.connectionAcceptanceRate !== undefined && String(row.connectionAcceptanceRate).trim() !== "";
    const providerAcceptanceRate = Number(row.connectionAcceptanceRate);
    const acceptanceRate = hasProviderAcceptanceRate && Number.isFinite(providerAcceptanceRate)
      ? providerAcceptanceRate <= 1 ? providerAcceptanceRate * 100 : providerAcceptanceRate
      : Number(row.connectionsSent) ? (accepted / Number(row.connectionsSent)) * 100 : 0;
    const launch = launchById.get(String(row.campaignId ?? "")) ?? launchByName.get(name.toLowerCase());
    const launchedAt = launch ? String(launch.startedAt ?? launch.creationTime ?? "") : "";
    return {
      workspaceId: String(workspace.id), client: String(workspace.name), campaignId: String(row.campaignId ?? ""), name,
      connectionsSent: Number(row.connectionsSent ?? 0), connectionsAccepted: accepted,
      replies, replies7d, messagesStarted: Number(row.totalMessageStarted ?? 0) + Number(row.totalInmailStarted ?? 0),
      acceptanceRate, replyRate: (() => { const messaged = Number(row.totalMessageStarted ?? 0) + Number(row.totalInmailStarted ?? 0) || accepted; return messaged ? replies / messaged * 100 : 0; })(),
      positiveReplies, positiveReplyRate: accepted ? positiveReplies / accepted * 100 : 0,
      launchedAt: launchedAt || null, status: launch ? String(launch.status ?? "") || null : null,
    };
  }));
  const average = (key) => campaignMetrics.length ? campaignMetrics.reduce((sum, row) => sum + row[key], 0) / campaignMetrics.length : 0;
  const total = (pick) => campaignMetrics.reduce((sum, row) => sum + pick(row), 0);
  const pooledSent = total((row) => row.connectionsSent), pooledAccepted = total((row) => row.connectionsAccepted);
  const pooledReplies = total((row) => row.replies), pooledMessaged = total((row) => row.messagesStarted || row.connectionsAccepted);
  const campaignAverages = { replyRate: pooledMessaged ? (pooledReplies / pooledMessaged) * 100 : 0, acceptanceRate: pooledSent ? (pooledAccepted / pooledSent) * 100 : 0, positiveReplyRate: pooledAccepted ? (total((row) => row.positiveReplies) / pooledAccepted) * 100 : 0 };
  const workspaceDetails = selected.map((row) => ({ id: String(row.id), name: String(row.name), slug: String(row.slug), logoUrl: row.logo_url ? String(row.logo_url) : null, accentColor: row.accent_color ? String(row.accent_color) : null }));
  return { ok: true, status: "live", totalReplies: inbound.length, messagesSent: outbound.length, activeConversations: conversations.length, replies7d: recentMessages.length, trend, trendLabels, averageDailyReplies, averageResponseMinutes, campaignMetrics, campaignAverages, campaigns: groupPerformance("campaign"), senders: groupPerformance("sender"), clientPerformance, queueMix, clientLoad, workspaces: selected.map((row) => row.name), workspaceDetails };
}

/* ----------------------------------------------------------------------------------------------- */

function useFakeDatabase(t, options) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = fakeFetch(db, { ...options, calls });
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}
const get = async (path) => (await fetch(`${SUPABASE}/rest/v1/${path}`)).json();

test("the fixture actually exercises paging, ties and odd attribution", () => {
  assert.ok(db.rr_conversations.length > 1000, "conversation read must page");
  assert.ok(db.rr_messages.length > 3000);
  assert.ok(db.rr_messages.some((row, index) => index && row.sent_at.slice(0, 19) === db.rr_messages[index - 1].sent_at.slice(0, 19)));
});

// The RPC path runs first: a 404 from the fallback run is remembered for five minutes by the route.
for (const [label, rpc] of [["with the database function", true], ["without it (row-by-row fallback)", false]]) {
  test(`/api/analytics matches the old computation ${label}`, async (t) => {
    const calls = useFakeDatabase(t, { rpc });
    const expected = await legacyAnalytics(get);
    calls.length = 0;
    const { GET } = await import("../app/api/analytics/route.ts");
    const response = await GET(new Request("https://app.test/api/analytics?fresh=1"));
    assert.equal(response.status, 200);
    const actual = await response.json();
    assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)));
    // Sanity: the comparison is about something.
    assert.ok(actual.totalReplies > 1000 && actual.campaignMetrics.length > 0 && actual.campaigns.length > 3);
    assert.ok(actual.campaignMetrics.some((row) => row.positiveReplies > 0 && row.replies7d > 0));
    const messageReads = calls.filter((url) => url.includes("rr_messages"));
    if (rpc) assert.equal(messageReads.length, 0, "the function path reads no message rows");
    else assert.ok(messageReads.every((url) => !/raw_data(?!->)/.test(decodeURIComponent(url))), "raw_data is never selected whole");
  });
}

test("/api/analytics matches for a subset of workspaces", async (t) => {
  useFakeDatabase(t, { rpc: true });
  const expected = await legacyAnalytics(get, ["willow", "cotool"]);
  const { GET } = await import("../app/api/analytics/route.ts");
  const actual = await (await GET(new Request("https://app.test/api/analytics?workspaces=willow,cotool&fresh=1"))).json();
  assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)));
});

test("a repeat request is served from the cache, and a matching ETag gets a 304", async (t) => {
  const calls = useFakeDatabase(t, { rpc: true });
  const { GET } = await import("../app/api/analytics/route.ts");
  const first = await GET(new Request("https://app.test/api/analytics?workspaces=bluevia&fresh=1"));
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const body = await first.text();
  calls.length = 0;
  const second = await GET(new Request("https://app.test/api/analytics?workspaces=bluevia"));
  assert.equal(await second.text(), body);
  assert.equal(calls.length, 0, "no database or HeyReach call inside the cache window");
  const unchanged = await GET(new Request("https://app.test/api/analytics?workspaces=bluevia", { headers: { "if-none-match": etag } }));
  assert.equal(unchanged.status, 304);
  const forced = await GET(new Request("https://app.test/api/analytics?workspaces=bluevia&fresh=1"));
  assert.equal(await forced.text(), body);
  assert.ok(calls.length > 0, "?fresh=1 reads again");
});

/* ----------------------------------------------------------------------------------------------- */

/** What the old client route derived from inbound messages; everything else in it is untouched. */
function legacyClientReplies(slug) {
  const workspace = db.rr_workspaces.find((row) => row.slug === slug);
  const conversationIds = new Set(db.rr_conversations.filter((row) => row.workspace_id === workspace.id).map((row) => row.id));
  const weekAgo = Date.now() - 7 * 86_400_000;
  const positiveByCampaign = new Map();
  const repliesByCampaign = new Map();
  let replies7d = 0;
  let inbound = 0;
  const positiveLeads = new Map();
  for (const message of db.rr_messages) {
    if (!conversationIds.has(message.conversation_id) || message.direction !== "inbound") continue;
    inbound += 1;
    const radar = message.raw_data?.reply_radar;
    const name = radar && typeof radar === "object" && !Array.isArray(radar) && radar.campaign && typeof radar.campaign === "object" && !Array.isArray(radar.campaign) ? radar.campaign.name : null;
    const campaign = String(name ?? "").trim().toLowerCase();
    if (Date.parse(String(message.sent_at ?? "")) >= weekAgo) replies7d += 1;
    if (!campaign) continue;
    repliesByCampaign.set(campaign, (repliesByCampaign.get(campaign) ?? 0) + 1);
    const sentiment = radar && typeof radar === "object" && !Array.isArray(radar) ? radar.sentiment : null;
    // Positive is counted per lead (conversation), not per message: a lead with three positive messages
    // is one positive lead, matching HeyReach's "Interested leads".
    if (String(sentiment ?? "").toLowerCase() === "positive") {
      const leads = positiveLeads.get(campaign) ?? new Set();
      leads.add(message.conversation_id);
      positiveLeads.set(campaign, leads);
    }
  }
  for (const [campaign, leads] of positiveLeads) positiveByCampaign.set(campaign, leads.size);
  return { conversations: conversationIds.size, inbound, replies7d, positiveByCampaign, repliesByCampaign };
}

for (const [label, rpc] of [["with the database function", true], ["without it (row-by-row fallback)", false]]) {
  test(`/api/analytics/client matches the old reply counts ${label}`, async (t) => {
    useFakeDatabase(t, { rpc });
    const { GET } = await import("../app/api/analytics/client/route.ts");
    for (const slug of ["bluevia", "willow"]) {
      const payload = await (await GET(new Request(`https://app.test/api/analytics/client?client=${slug}&fresh=1`))).json();
      const expected = legacyClientReplies(slug);
      assert.equal(payload.ok, true);
      assert.equal(payload.conversations, expected.conversations);
      assert.equal(payload.repliesSynced, expected.inbound);
      assert.equal(payload.replies7d, expected.replies7d);
      for (const campaign of payload.campaigns) {
        const key = campaign.name.trim().toLowerCase();
        assert.equal(campaign.positiveReplies, expected.positiveByCampaign.get(key) ?? 0, campaign.name);
        assert.equal(campaign.repliesSynced, expected.repliesByCampaign.get(key) ?? 0, campaign.name);
      }
      assert.ok(payload.campaigns.some((campaign) => campaign.positiveReplies > 0));
    }
  });
}
