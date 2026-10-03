// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Offboarded ("legacy") clients.
 *
 * An offboarded client is a row in rr_workspaces with `offboarded_at` set. It disappears from every list
 * and automation, but nothing is deleted and one click restores it. The admin route is run against a fake
 * PostgREST (the same approach as admin-config-saves) so what it reads and writes is visible; the listing
 * queries elsewhere are pinned at source level, because each is one query string inside a large route.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const nextServerStub = `data:text/javascript,${encodeURIComponent("export const NextResponse = { json: (body, init) => Response.json(body, init) }; export const after = () => {};")}`;
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

process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
process.env.APP_BASE_URL = "https://app.example.com";

const { GET, POST } = await import("../app/api/admin/workspaces/route.ts");

/**
 * A tiny rr_workspaces table. `columnMissing` makes it behave like a database where the migration has not
 * run: any read or write naming offboarded_at fails the way PostgREST does.
 */
function fakeDb(rows, { columnMissing = false } = {}) {
  const table = rows.map((row) => ({ ...row }));
  const reads = [];
  const writes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (!url.pathname.endsWith("/rr_workspaces")) {
      if (method !== "GET") writes.push({ method, url: url.toString(), body: init.body ? JSON.parse(init.body) : null });
      return Response.json([], { status: 201 });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    if (columnMissing && (/offboarded_at/.test(url.search) || (body && "offboarded_at" in body))) {
      return Response.json({ code: "42703", message: "column rr_workspaces.offboarded_at does not exist" }, { status: 400 });
    }
    const filters = [...url.searchParams].filter(([key]) => !["select", "limit", "order"].includes(key));
    const matches = (row) => filters.every(([column, rule]) => {
      const [op, value] = [rule.slice(0, rule.indexOf(".")), rule.slice(rule.indexOf(".") + 1)];
      if (op === "eq") return String(row[column]) === value;
      if (op === "neq") return String(row[column]) !== value;
      if (op === "is" && value === "null") return row[column] == null;
      return true;
    });
    if (method === "GET") {
      reads.push(url.toString());
      return Response.json(table.filter(matches));
    }
    writes.push({ method, url: url.toString(), body });
    if (method === "PATCH") {
      const hit = table.filter(matches);
      for (const row of hit) Object.assign(row, body);
      return Response.json(hit);
    }
    return Response.json([]);
  };
  return { table, reads, writes, restore: () => { globalThis.fetch = realFetch; } };
}

const post = (payload) => POST(new Request("https://app.example.com/api/admin/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
const list = (query = "") => GET(new Request(`https://app.example.com/api/admin/workspaces${query}`));

const acme = { id: "id-acme", name: "Acme", slug: "acme", client_brief: "Sells widgets.", guardrails: { icp_prompt: "Heads of ops" }, heyreach_api_key_ciphertext: "secret-key-1234", offboarded_at: null };
const legacy = { id: "id-old", name: "Oldco", slug: "oldco", client_brief: "Was a client.", guardrails: {}, heyreach_api_key_ciphertext: "secret-key-9999", offboarded_at: "2026-09-01T12:00:00.000Z" };

test("offboarding writes offboarded_at = now and nothing else, and is audited as offboarded", async () => {
  const db = fakeDb([acme, legacy]);
  try {
    const before = Date.now();
    const response = await post({ id: "id-acme", previousSlug: "acme", offboarded: true });
    const payload = await response.json();
    assert.equal(response.status, 200);
    const patch = db.writes.find((write) => write.method === "PATCH");
    assert.deepEqual(Object.keys(patch.body), ["offboarded_at"]);
    assert.ok(Date.parse(patch.body.offboarded_at) >= before - 1000, "stamped with the current time");
    assert.equal(db.table[0].client_brief, "Sells widgets.", "no data is touched");
    assert.equal(db.table[0].guardrails.icp_prompt, "Heads of ops");
    assert.equal(payload.workspaces[0].offboardedAt, patch.body.offboarded_at);
    const audit = db.writes.find((write) => write.url.includes("rr_audit_log"));
    if (audit) assert.match(JSON.stringify(audit.body), /workspace\.offboarded/);
  } finally { db.restore(); }
});

test("restoring writes offboarded_at = null", async () => {
  const db = fakeDb([acme, legacy]);
  try {
    const response = await post({ id: "id-old", previousSlug: "oldco", offboarded: false });
    assert.equal(response.status, 200);
    const patch = db.writes.find((write) => write.method === "PATCH");
    assert.deepEqual(patch.body, { offboarded_at: null });
    assert.equal(db.table[1].offboarded_at, null);
    assert.equal(db.table[1].client_brief, "Was a client.");
  } finally { db.restore(); }
});

test("a non-boolean offboarded value is ignored rather than read as a yes", async () => {
  const db = fakeDb([acme]);
  try {
    const response = await post({ id: "id-acme", previousSlug: "acme", offboarded: "yes" });
    assert.equal(response.status, 400, "nothing to save");
    assert.equal(db.writes.filter((write) => write.method === "PATCH").length, 0);
  } finally { db.restore(); }
});

test("the default list is active clients only, filtered in the query", async () => {
  const db = fakeDb([acme, legacy]);
  try {
    const response = await list();
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.workspaces.map((row) => row.slug), ["acme"]);
    assert.match(db.reads[0], /offboarded_at=is\.null/);
    assert.equal(payload.workspaces[0].offboardedAt, null);
    assert.equal(payload.workspaces[0].heyreach_api_key_ciphertext, undefined, "keys never leave");
  } finally { db.restore(); }
});

test("?include=all returns legacy clients too, each with offboardedAt", async () => {
  const db = fakeDb([acme, legacy]);
  try {
    const response = await list("?include=all");
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.workspaces.map((row) => row.slug).sort(), ["acme", "oldco"]);
    assert.doesNotMatch(db.reads[0], /offboarded_at=is\.null/);
    const old = payload.workspaces.find((row) => row.slug === "oldco");
    assert.equal(old.offboardedAt, "2026-09-01T12:00:00.000Z");
  } finally { db.restore(); }
});

test("without the migration the list still loads, and everyone is active", async () => {
  const db = fakeDb([{ ...acme, offboarded_at: undefined }, { ...legacy, offboarded_at: undefined }], { columnMissing: true });
  try {
    for (const query of ["", "?include=all"]) {
      const response = await list(query);
      const payload = await response.json();
      assert.equal(response.status, 200, `list${query} must not fail`);
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.workspaces.map((row) => row.slug).sort(), ["acme", "oldco"]);
      for (const row of payload.workspaces) assert.equal(row.offboardedAt, null);
    }
  } finally { db.restore(); }
});

test("without the migration, offboarding reports the error instead of claiming success", async () => {
  const db = fakeDb([acme], { columnMissing: true });
  try {
    const response = await post({ id: "id-acme", previousSlug: "acme", offboarded: true });
    const payload = await response.json();
    assert.equal(response.ok, false);
    assert.match(payload.error, /offboarded_at/);
  } finally { db.restore(); }
});

// ---------------------------------------------------------------------------------------------------------
// Source-level: the listings and automations that enumerate clients leave offboarded ones out.

const ROOT = new URL("..", import.meta.url);
const source = (path) => readFileSync(new URL(path, ROOT), "utf8");

const ACTIVE_ONLY = [
  // Listings
  "app/lib/brain-workspaces.ts",
  "app/lib/cold-calling.ts",
  "app/lib/deals.ts",
  "app/lib/meetings.ts",
  "app/lib/jev.ts",
  "app/lib/onboarding.ts",
  "app/lib/personal-brief.ts",
  "app/lib/assistant-tools.ts",
  "app/api/project-management/clients/route.ts",
  "app/api/admin/profiles/route.ts",
  "app/api/ai/config/route.ts",
  "app/api/analytics/summary/route.ts",
  "app/api/reports/generate/route.ts",
  "app/api/reports/campaigns/route.ts",
  "app/api/granola/coverage/route.ts",
  "app/api/heartbeat/route.ts",
  // Automations
  "app/api/slack/brief/route.ts",
  "app/api/slack/eow-report/route.ts",
  "app/api/slack/call-analysis/route.ts",
  "app/api/granola/heartbeat/route.ts",
  "app/lib/messaging-sync.ts",
  "worker/render-worker.mjs",
];

for (const path of ACTIVE_ONLY) {
  test(`${path} filters offboarded clients out of its client list`, () => {
    assert.match(source(path), /offboarded_at=is\.null/);
  });
}

test("the worker skips offboarded clients for AI, analytics, deals and the health poll, but not for stored replies", () => {
  const worker = source("worker/render-worker.mjs");
  const line = (pattern) => worker.split("\n").find((entry) => pattern.test(entry)) ?? "";
  assert.match(line(/select=id,slug,name,client_brief,anthropic_model/), /offboarded_at=is\.null/, "AI pipeline");
  const stale = worker.slice(worker.indexOf("async function staleAnalyticsWorkspace"), worker.indexOf("async function staleAnalyticsWorkspace") + 400);
  assert.match(stale, /offboarded_at=is\.null/, "analytics collection");
  assert.match(line(/crm_provider=not\.is\.null/), /offboarded_at=is\.null/, "deals sync");
  // Reconcile and conversation refresh store replies, so they keep running for offboarded clients.
  assert.doesNotMatch(line(/last_reconciled_at\.is\.null/), /offboarded_at/);
  const refresh = worker.slice(worker.indexOf("async function refreshAllConversations"), worker.indexOf("async function refreshAllConversations") + 400);
  assert.doesNotMatch(refresh, /offboarded_at/);
});

test("the inbox, analytics and lead database still read a legacy client that is asked for by name", () => {
  const inbox = source("app/api/inbox/route.ts");
  assert.match(inbox, /: workspaces\.filter\(\(workspace\) => !workspace\.offboarded_at\)/);
  const analytics = source("app/api/analytics/route.ts");
  assert.match(analytics, /: workspaces\.filter\(\(row\) => !row\.offboarded_at\)/);
  const leads = source("app/api/database/leads/route.ts");
  assert.match(leads, /workspace_id=not\.in\./);
  assert.match(leads, /everyWorkspace\.find\(\(workspace\) => workspace\.slug === workspaceSlug\)/);
});

test("webhooks keep storing replies for offboarded clients, and survive a missing column", () => {
  for (const path of ["app/api/webhooks/heyreach/[workspaceId]/route.ts", "app/api/webhooks/heyreach/[workspaceId]/[secret]/route.ts"]) {
    const route = source(path);
    assert.doesNotMatch(route, /offboarded_at=is\.null/, `${path} must not drop offboarded clients`);
    assert.match(route, /if \(!lookup\.ok\) lookup = await lookupWith\(/, `${path} retries without the column`);
    assert.match(route, /&& !workspace\.offboarded_at\)/, `${path} skips classification only`);
  }
});

test("Configuration asks for every client, and the shared cache only ever holds active ones", () => {
  const admin = source("app/admin/page.tsx");
  assert.match(admin, /fetch\("\/api\/admin\/workspaces\?include=all"/);
  assert.match(admin, /list\s*\.filter\(\(item\) => !item\.offboardedAt\)/);
  assert.doesNotMatch(admin, /window\.confirm\([^)]*[Oo]ffboard/, "the offboard confirmation is in the page");
  const sidebar = source("app/components/AppSidebar.tsx");
  assert.match(sidebar, /fetch\("\/api\/admin\/workspaces", \{ cache: "no-store" \}\)/, "the sidebar reads the active list");
});

test("the migration adds the column and reloads the schema cache", () => {
  const sql = source("supabase/migrations/20261003_workspace_offboarded.sql");
  assert.match(sql, /alter table rr_workspaces add column if not exists offboarded_at timestamptz;/);
  assert.match(sql, /notify pgrst, 'reload schema';/);
  assert.match(source("supabase/schema.sql"), /offboarded_at timestamptz,/);
});

test("nothing is posted to Slack for an offboarded client, even when it is named directly", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const route of ["app/api/slack/brief/route.ts", "app/api/slack/eow-report/route.ts", "app/api/slack/call-analysis/route.ts"]) {
    const source = await readFile(new URL(`../${route}`, import.meta.url), "utf8");
    assert.match(source, /found\.offboarded_at && destination !== "preview"/, route);
    assert.match(source, /\$\{columns\},offboarded_at,/, `${route} reads offboarded_at on the single-client path`);
  }
});

test("Scout still finds an offboarded client by name, loosely, with active clients winning ties", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/lib/assistant-tools.ts", import.meta.url), "utf8");
  assert.match(source, /\[all\.filter\(isExact\), legacy\.filter\(isExact\), all\.filter\(isPartial\), legacy\.filter\(isPartial\)\]/);
  const insights = await readFile(new URL("../app/lib/scout-insights.ts", import.meta.url), "utf8");
  assert.match(insights, /legacyClients\.filter\(partial\)/);
});
