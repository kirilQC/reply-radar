// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Date windows and full reads, driven through the real routes against a fake Supabase.
 *
 * Every bug here was silent: a report that read only the first 1,000 conversations, a custom range that
 * dropped its last day, an October report labelled September, a 14-day chart bucketed on UTC days, a
 * failed morning brief that counted as sent so it was never retried. Nothing threw, so the only way to
 * keep them fixed is to look at what the routes asked the database for and what they answered.
 *
 * Same harness as inbox-data-integrity: a resolve hook fills in the `.ts` extension Next resolves for
 * itself, `next/server` is stood in by `Response.json`, and `fetch` is replaced per test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

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

const SUPABASE = "https://supabase.test";
process.env.SUPABASE_URL = SUPABASE;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
function stubFetch(t, handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (!url.startsWith(SUPABASE)) throw new Error(`Unexpected external call: ${url}`);
    return (await handler(decodeURIComponent(url.slice(`${SUPABASE}/rest/v1/`.length)), init)) ?? json([]);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}
/** limit/offset as PostgREST applies them, with its 1,000-row ceiling. */
function pageOf(path, rows) {
  const limit = Math.min(1000, Number(/[?&]limit=(\d+)/.exec(path)?.[1] ?? 1000));
  const offset = Number(/[?&]offset=(\d+)/.exec(path)?.[1] ?? 0);
  return rows.slice(offset, offset + limit);
}
const idsIn = (path, column) => (new RegExp(`${column}=in\\.\\(([^)]*)\\)`).exec(path)?.[1] ?? "").split(",").filter(Boolean);
const WORKSPACE = { id: "ws-1", name: "Willow", slug: "willow", timezone: "America/New_York", heyreach_api_key_ciphertext: "" };

async function generate(t, body, { conversations = [], messages = [] } = {}) {
  const { POST } = await import("../app/api/reports/generate/route.ts");
  const calls = stubFetch(t, (path) => {
    if (path.startsWith("rr_workspaces")) return json([WORKSPACE]);
    if (path.startsWith("rr_conversations")) return json(pageOf(path, conversations));
    if (path.startsWith("rr_messages")) {
      const wanted = new Set(idsIn(path, "conversation_id"));
      // sent_at bounds honoured like PostgREST, so "replied before the period" reads only earlier rows.
      const decoded = decodeURIComponent(path);
      const gte = decoded.match(/sent_at=gte\.([^&]+)/)?.[1];
      const lt = decoded.match(/sent_at=lt\.([^&]+)/)?.[1];
      const inRange = (m) => (!gte || Date.parse(m.sent_at) >= Date.parse(gte)) && (!lt || Date.parse(m.sent_at) < Date.parse(lt));
      return json(pageOf(path, messages.filter((m) => wanted.has(m.conversation_id) && inRange(m))));
    }
    return json([]);
  });
  const response = await POST(new Request("https://app.test/api/reports/generate", { method: "POST", body: JSON.stringify(body) }));
  return { payload: await response.json(), calls };
}

test("a report reads every conversation, not the first 1,000", async (t) => {
  const conversations = Array.from({ length: 2500 }, (_, i) => ({ id: `c${String(i).padStart(4, "0")}`, lead_id: "", workspace_id: "ws-1" }));
  // Only conversations past row 2,000 have replies, so a capped read would report none.
  const messages = conversations.slice(2000).map((c, i) => ({ id: `m${i}`, conversation_id: c.id, direction: "inbound", body: `Reply ${i}`, sent_at: "2026-09-15T15:00:00Z", raw_data: {} }));
  const { payload, calls } = await generate(t, { workspaceSlug: "willow", period: "all-time" }, { conversations, messages });
  assert.equal(payload.ok, true);
  assert.equal(payload.clients[0].summary.totalReplies, 500);
  const conversationReads = calls.filter((url) => url.includes("rr_conversations"));
  assert.equal(conversationReads.length, 3, "three pages of 1,000");
  assert.ok(conversationReads.every((url) => url.includes("order=id.asc")), "paged reads carry a stable order");
});

test("a thread batch with more than 1,000 replies is read in full", async (t) => {
  const conversations = [{ id: "c1", lead_id: "", workspace_id: "ws-1" }];
  const messages = Array.from({ length: 1500 }, (_, i) => ({ id: `m${i}`, conversation_id: "c1", direction: "inbound", body: `Reply ${i}`, sent_at: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(), raw_data: {} }));
  const { payload } = await generate(t, { workspaceSlug: "willow", period: "all-time" }, { conversations, messages });
  // Replies are counted per lead now (one lead here), so the full read shows in the per-day trend.
  assert.equal(payload.clients[0].trend.reduce((total, row) => total + row.replies, 0), 1500);
  assert.equal(payload.clients[0].summary.totalReplies, 1);
});

test("a custom range covers its last day, on New York midnights", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T16:00:00Z") });
  const conversations = [{ id: "c1", lead_id: "", workspace_id: "ws-1" }];
  const { payload, calls } = await generate(t, { workspaceSlug: "willow", period: "custom", since: "2026-10-01", until: "2026-10-07", timeZone: "Europe/London" }, { conversations, messages: [] });
  const read = decodeURIComponent(calls.find((url) => url.includes("rr_messages")));
  assert.match(read, /sent_at=gte\.2026-10-01T04:00:00\.000Z/);
  assert.match(read, /sent_at=lt\.2026-10-08T04:00:00\.000Z/, "until is exclusive at the start of the following day");
  // The page prints `until` as "ending <date>", so it is the last instant inside the window.
  assert.equal(payload.until, "2026-10-08T03:59:59.999Z");
  assert.equal(payload.untilExclusive, "2026-10-08T04:00:00.000Z");
});

test("a custom range across the November DST change uses each day's own offset", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-12-01T16:00:00Z") });
  const { payload } = await generate(t, { workspaceSlug: "willow", period: "custom", since: "2026-10-31", until: "2026-11-01" }, { conversations: [{ id: "c1", lead_id: "", workspace_id: "ws-1" }] });
  assert.equal(payload.since, "2026-10-31T04:00:00.000Z", "EDT, UTC-4");
  assert.equal(payload.untilExclusive, "2026-11-02T05:00:00.000Z", "EST, UTC-5");
});

test("period starts are local midnight and the label names the local month", async (t) => {
  const conversations = [{ id: "c1", lead_id: "", workspace_id: "ws-1" }];
  // 10pm on September 30 in New York is already October 1 in UTC.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-01T02:00:00Z") });
  let { payload } = await generate(t, { workspaceSlug: "willow", period: "monthly", timeZone: "America/New_York" }, { conversations });
  assert.equal(payload.periodLabel, "September 2026");
  assert.equal(payload.since, "2026-09-01T04:00:00.000Z");
  // 1am on October 1 in New York.
  t.mock.timers.setTime(Date.parse("2026-10-01T05:00:00Z"));
  ({ payload } = await generate(t, { workspaceSlug: "willow", period: "monthly", timeZone: "America/New_York" }, { conversations }));
  assert.equal(payload.periodLabel, "October 2026");
  assert.equal(payload.since, "2026-10-01T04:00:00.000Z");
  ({ payload } = await generate(t, { workspaceSlug: "willow", period: "quarterly", timeZone: "America/New_York" }, { conversations }));
  assert.equal(payload.periodLabel, "Q4 2026");
  assert.equal(payload.since, "2026-10-01T04:00:00.000Z");
});

test("weeks start on Monday at local midnight", async (t) => {
  // Sunday October 4, 10pm in New York (Monday in UTC).
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-05T02:00:00Z") });
  let { payload } = await generate(t, { workspaceSlug: "willow", period: "weekly", timeZone: "America/New_York" }, { conversations: [{ id: "c1", lead_id: "", workspace_id: "ws-1" }] });
  assert.equal(payload.since, "2026-09-28T04:00:00.000Z");
  assert.equal(payload.periodLabel, "Week of Sep 28, 2026");
  ({ payload } = await generate(t, { workspaceSlug: "willow", period: "daily", timeZone: "America/New_York" }, { conversations: [{ id: "c1", lead_id: "", workspace_id: "ws-1" }] }));
  assert.equal(payload.since, "2026-10-04T04:00:00.000Z");
  assert.equal(payload.periodLabel, "Oct 4, 2026");
});

test("average replies per day divides by calendar days, quiet days included", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T16:00:00Z") });
  const conversations = [{ id: "c1", lead_id: "", workspace_id: "ws-1" }];
  // Fourteen leads replied, all on two of the seven days (replies are counted per lead).
  const conversations14 = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, lead_id: "", workspace_id: "ws-1" }));
  const messages = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, conversation_id: `c${i}`, direction: "inbound", body: `Reply ${i}`, sent_at: `2026-10-0${i < 7 ? 2 : 5}T15:${String(i).padStart(2, "0")}:00Z`, raw_data: {} }));
  const { payload } = await generate(t, { workspaceSlug: "willow", period: "custom", since: "2026-10-01", until: "2026-10-07" }, { conversations: conversations14, messages });
  assert.equal(payload.clients[0].summary.totalReplies, 14);
  assert.equal(payload.clients[0].summary.avgRepliesPerDay, 2);
});

test("the 14-day trend buckets replies by New York day", async (t) => {
  // Noon on October 2 in New York.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-02T16:00:00Z") });
  const { GET } = await import("../app/api/analytics/route.ts");
  stubFetch(t, (path) => {
    if (path.startsWith("rr_workspaces")) return json([{ id: "ws-1", name: "Willow", slug: "willow", heyreach_api_key_ciphertext: null }]);
    if (path.startsWith("rr_conversations")) return json(pageOf(path, [{ id: "c1", workspace_id: "ws-1", tier: "hot" }]));
    if (path.startsWith("rr_messages")) return json(pageOf(path, [
      // 9pm October 1 in New York, which is October 2 in UTC.
      { conversation_id: "c1", direction: "inbound", sent_at: "2026-10-02T01:00:00Z", raw_data: {} },
      { conversation_id: "c1", direction: "inbound", sent_at: "2026-10-02T14:00:00Z", raw_data: {} },
    ]));
    return json([]);
  });
  const response = await GET(new Request("https://app.test/api/analytics"));
  const payload = await response.json();
  assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 300));
  assert.equal(payload.trendLabels.at(-1), "10/2");
  assert.equal(payload.trendLabels.at(-2), "10/1");
  assert.equal(payload.trend.at(-1), 1, "today has the 10am reply only");
  assert.equal(payload.trend.at(-2), 1, "the 9pm reply belongs to the evening it was sent");
});

test("scout windows filter on New York midnights and default to New York's today", async (t) => {
  // 9pm October 2 in New York: UTC has already moved to October 3.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-03T01:00:00Z") });
  const { runInsightTool } = await import("../app/lib/scout-insights.ts");
  const calls = stubFetch(t, (path) => {
    if (path.startsWith("rr_workspaces")) return json([{ id: "ws-1", name: "Willow", slug: "willow", heyreach_api_key_ciphertext: "" }]);
    return json([]);
  });
  const result = await runInsightTool("reply_texts", { from: "2026-10-01", to: "2026-10-02" });
  assert.deepEqual(result.window, { from: "2026-10-01", to: "2026-10-02", days: 2 });
  const read = decodeURIComponent(calls.find((url) => url.includes("rr_messages")));
  assert.match(read, /sent_at=gte\.2026-10-01T04:00:00\.000Z/);
  assert.match(read, /sent_at=lt\.2026-10-03T04:00:00\.000Z/);
  const defaulted = await runInsightTool("reply_texts", {});
  assert.equal(defaulted.window.to, "2026-10-02");
});

/** The morning brief and EOW report lists, with one client and the given log rows. */
async function sentToday(t, route, rows) {
  // 9:30am Thursday October 1 in New York.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-01T13:30:00Z") });
  const { GET } = await import(route);
  stubFetch(t, (path) => {
    if (path.startsWith("rr_workspaces?select=id&")) return json([]);
    if (path.startsWith("rr_workspaces")) return json([{ id: "ws-1", name: "Willow", slug: "willow", timezone: "America/New_York", morning_brief_enabled: true, eow_report_enabled: true }]);
    if (path.startsWith("rr_slack_briefs")) return json(rows);
    return json([]);
  });
  const payload = await (await GET()).json();
  return payload.workspaces[0].sentToday;
}
const at = (iso) => new Date(Date.parse(iso)).toISOString();

for (const route of ["../app/api/slack/brief/route.ts", "../app/api/slack/eow-report/route.ts"]) {
  const name = route.includes("brief") ? "morning brief" : "EOW report";
  test(`${name}: a successful post today counts as sent`, async (t) => {
    assert.equal(await sentToday(t, route, [{ workspace_id: "ws-1", created_at: at("2026-10-01T12:00:00Z"), status: "success", destination: "internal" }]), true, "a success today counts");
  });
  test(`${name}: an error older than an hour does not count as sent`, async (t) => {
    assert.equal(await sentToday(t, route, [{ workspace_id: "ws-1", created_at: at("2026-10-01T12:00:00Z"), status: "error", destination: "internal" }]), false);
  });
  test(`${name}: an error within the hour holds off the retry`, async (t) => {
    assert.equal(await sentToday(t, route, [{ workspace_id: "ws-1", created_at: at("2026-10-01T13:00:00Z"), status: "error", destination: "internal" }]), true);
  });
  test(`${name}: a test-channel post never counts`, async (t) => {
    assert.equal(await sentToday(t, route, [{ workspace_id: "ws-1", created_at: at("2026-10-01T13:20:00Z"), status: "success", destination: "test" }]), false);
  });
}

test("a lead who first replied before the period is not one of its replied leads, as in HeyReach", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T16:00:00Z") });
  const conversations = [{ id: "old", lead_id: "", workspace_id: "ws-1" }, { id: "new", lead_id: "", workspace_id: "ws-1" }];
  const messages = [
    { id: "m1", conversation_id: "old", direction: "inbound", body: "Earlier reply", sent_at: "2026-09-20T15:00:00Z", raw_data: {} },
    { id: "m2", conversation_id: "old", direction: "inbound", body: "Still talking", sent_at: "2026-10-03T15:00:00Z", raw_data: {} },
    { id: "m3", conversation_id: "new", direction: "inbound", body: "First reply", sent_at: "2026-10-04T15:00:00Z", raw_data: {} },
  ];
  const { payload } = await generate(t, { workspaceSlug: "willow", period: "custom", since: "2026-10-01", until: "2026-10-07" }, { conversations, messages });
  assert.equal(payload.clients[0].summary.totalReplies, 1);
});
