// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The per-client analytics rebuild: the sequence walk, the tables it writes into, and the sort orders
 * the campaign table offers.
 *
 * These three are grouped because they are the parts of that feature with no visible failure. A
 * sequence walk that misses a node type leaves the copy blank and the page simply shows fewer rows. A
 * table missing from the schema means every upsert the worker makes 404s, which it catches and logs,
 * so the page stays on "collecting" indefinitely rather than breaking. A sort id the comparator does
 * not know falls through to the default order, so the menu offers an option that silently does
 * nothing — the exact defect the lead database shipped with and was rejected for.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sequenceCopy } from "../shared/campaign-sequence.mjs";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/analytics/page.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/analytics/client/route.ts", import.meta.url), "utf8");

/** A real shape: connection request → (accepted) message → follow-up, with an END on the other branch. */
const tree = {
  nodeType: "CONNECTION_REQUEST",
  payload: { messages: ["Hi {{firstName}}, saw your post on onboarding.", "B variant"], fallbackMessage: "Hi there." },
  conditionalNode: {
    nodeType: "MESSAGE",
    payload: { messages: ["Thanks for connecting — what does onboarding look like for you today?"] },
    conditionalNode: { nodeType: "MESSAGE", payload: { messages: ["Bumping this in case it got buried."] } },
    unconditionalNode: { nodeType: "END" },
  },
  unconditionalNode: { nodeType: "END" },
};

test("the opener and the first message after acceptance are both found in a nested tree", () => {
  const copy = sequenceCopy(tree);
  assert.equal(copy.firstTouch, "Hi {{firstName}}, saw your post on onboarding.");
  assert.equal(copy.followUp, "Thanks for connecting — what does onboarding look like for you today?");
});

test("the A variant wins over the fallback, which is only for a missing first name", () => {
  assert.equal(sequenceCopy({ nodeType: "CONNECTION_REQUEST", payload: { messages: ["Variant A"], fallbackMessage: "Hi there." } }).firstTouch, "Variant A");
  assert.equal(sequenceCopy({ nodeType: "CONNECTION_REQUEST", payload: { messages: [], fallbackMessage: "Hi there." } }).firstTouch, "Hi there.");
});

test("the shallowest message wins, because it is the one sent first", () => {
  // The third message in the tree above is a chase-up. Showing it as the opener would put the worst
  // words in the sequence next to the campaign's rates.
  assert.notEqual(sequenceCopy(tree).followUp, "Bumping this in case it got buried.");
});

test("END nodes are not counted as steps", () => {
  // Four nodes, two of them END: a request, two messages, and the two terminators.
  assert.equal(sequenceCopy(tree).steps, 3);
});

test("INMAIL counts as the first thing said to somebody who let us in", () => {
  const copy = sequenceCopy({ nodeType: "CONNECTION_REQUEST", payload: { messages: ["Opener"] }, conditionalNode: { nodeType: "INMAIL", payload: { messages: ["Body"] } } });
  assert.equal(copy.followUp, "Body");
});

test("a missing, empty or cyclic sequence returns empty copy rather than throwing", () => {
  for (const input of [null, undefined, {}, "not a tree", 7]) {
    assert.deepEqual(sequenceCopy(input).firstTouch, "");
  }
  // A node that is its own child would otherwise walk forever.
  const loop = { nodeType: "MESSAGE", payload: { messages: ["once"] } };
  loop.conditionalNode = loop;
  assert.equal(sequenceCopy(loop).followUp, "once");
});

/** The columns a `create table` block declares, read from the schema rather than restated here. */
const columnsOf = (table) => {
  const start = schema.indexOf(`create table if not exists ${table}`);
  assert.notEqual(start, -1, `${table} is missing from the schema — every worker upsert into it would 404`);
  const body = schema.slice(start, schema.indexOf("\n);", start));
  return new Set(
    body
      .split("\n")
      .map((line) => line.trim().match(/^([a-z_]+)\s+(uuid|text|jsonb|timestamptz|date|integer|text\[\])\b/)?.[1])
      .filter(Boolean),
  );
};

/** A slice of the route between two landmarks, so a `row.` scrape can be attributed to one table. */
const section = (from, to) => {
  const start = route.indexOf(from);
  const end = route.indexOf(to);
  assert.ok(start !== -1 && end > start, `could not find the ${from} … ${to} section of the route`);
  return route.slice(start, end);
};

test("rr_campaign_stats holds every field the client route reads off a campaign row", () => {
  const columns = columnsOf("rr_campaign_stats");
  // Taken from the route's own reads inside the campaign mapping, so adding a field there without
  // adding the column fails here rather than showing a zero on the page.
  for (const [, name] of section("const campaigns = campaignRows.map", "const days = dayKeys(").matchAll(/\brow\.([a-z_]+)\b/g)) {
    assert.ok(columns.has(name), `rr_campaign_stats.${name} is read by the route but not declared`);
  }
  // The two that the page's headline feature depends on outright.
  assert.ok(columns.has("sender_ids"), "days-left divides by the number of senders assigned");
  assert.ok(columns.has("leads_pending"), "days-left is pending leads over daily capacity");
});

test("rr_daily_stats is keyed per sender per day, which is what the stacked chart needs", () => {
  const columns = columnsOf("rr_daily_stats");
  for (const [, name] of section("for (const row of dailyRows)", "const senderSeries").matchAll(/\brow\??\.([a-z_]+)\b/g)) {
    assert.ok(columns.has(name), `rr_daily_stats.${name} is read by the route but not declared`);
  }
  for (const name of ["day", "sender_id", "sender_name", "connections_sent", "connections_accepted", "daily_limit"]) {
    assert.ok(columns.has(name), `rr_daily_stats.${name} is missing`);
  }
  const start = schema.indexOf("create table if not exists rr_daily_stats");
  const body = schema.slice(start, schema.indexOf("\n);", start));
  // Without the sender in the key, the all-senders total row and every per-sender row collide and the
  // table holds whichever was written last.
  assert.match(body, /primary key \(workspace_id, day, sender_id\)/);
});

test("both analytics tables have row level security on, like every other table here", () => {
  for (const table of ["rr_campaign_stats", "rr_daily_stats"]) {
    assert.ok(schema.includes(`alter table ${table} enable row level security`), `${table} is not locked down`);
  }
});

test("every sort the campaign table offers is a sort the comparator implements", () => {
  const options = [...page.matchAll(/\{ id: "([a-z-]+)", label: "[^"]+" \}/g)].map(([, id]) => id);
  assert.ok(options.length >= 12, `expected the full sort menu, found ${options.length}`);
  const comparator = page.slice(page.indexOf("const sortCampaigns ="), page.indexOf("const leaderMetrics"));
  assert.ok(comparator.includes("switch (sort)"), "the comparator was not found where this test expects it");
  for (const id of options) {
    // The default order needs no case of its own; everything else does, or picking it does nothing.
    if (id === options[0]) continue;
    assert.ok(comparator.includes(`"${id}"`), `sort "${id}" is offered in the menu but never handled`);
  }
});

test("the client route reads Supabase and nothing else", () => {
  /*
   * The whole point of the worker-backed tables: a page load must not wait on somebody else's API. The
   * check is on where the route can fetch from rather than on whether it says "HeyReach", because the
   * comments in it say so repeatedly and correctly — the tables it reads are a copy of HeyReach's
   * answers, which is the thing worth explaining.
   */
  const targets = [...route.matchAll(/fetch\(\s*`([^`]+)`/g)].map(([, target]) => target);
  assert.deepEqual(targets, ["${url}/rest/v1/${path}"], `the route fetches from ${targets.join(", ")}`);
  // And it must not pull `raw_data` whole to read one field out of it, which is the mistake the
  // account-wide analytics route makes and the reason its payload runs to megabytes.
  assert.ok(!/select=[^`"']*\braw_data\b(?!->)/.test(route), "raw_data is being selected whole rather than by JSON path");
  assert.match(route, /raw_data->reply_radar->>sentiment/);
});
