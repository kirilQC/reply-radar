// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The configuration saves that used to destroy data quietly.
 *
 * Each case below is a bug that shipped: creating a client with a taken slug overwrote the existing
 * client; a logo upload wiped the client's AI prompts; the workspace form reverted guardrails edited on
 * another screen; the onboarding setup let one client's Slack channel be saved as another's; the login
 * page followed `?next=/%5Cevil.com` off-site. The route is run against a fake PostgREST so what it would
 * have written is visible.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
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

const SUPABASE = "https://fake.supabase.test";
process.env.SUPABASE_URL = SUPABASE;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
process.env.APP_BASE_URL = "https://app.example.com";

const { workspaceSlug, safeNextPath, webhookUrlFor } = await import("../app/lib/public-url.ts");
const { channelClashMessage, firstChannelClash } = await import("../app/lib/channel-clash.ts");
const { POST } = await import("../app/api/admin/workspaces/route.ts");
const { saveReplyRadarConfig } = await import("../app/lib/onboarding.ts");

/** A tiny rr_workspaces table behind a fetch that records every write. */
function fakeDb(rows) {
  const table = rows.map((row) => ({ ...row }));
  const writes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (!url.pathname.endsWith("/rr_workspaces")) return Response.json([], { status: 201 });
    const filters = [...url.searchParams].filter(([key]) => !["select", "limit", "order", "on_conflict"].includes(key));
    const matches = (row) => filters.every(([column, rule]) => {
      const [op, value] = [rule.slice(0, rule.indexOf(".")), rule.slice(rule.indexOf(".") + 1)];
      if (op === "eq") return String(row[column]) === value;
      if (op === "neq") return String(row[column]) !== value;
      return true;
    });
    if (method === "GET") return Response.json(table.filter(matches));
    const body = init.body ? JSON.parse(init.body) : null;
    writes.push({ method, url: url.toString(), body, prefer: init.headers?.Prefer ?? "" });
    if (method === "POST") {
      if (table.some((row) => row.slug === body.slug)) return Response.json({ code: "23505", message: "duplicate key value violates unique constraint \"rr_workspaces_slug_key\"", details: "Key (slug)=(x) already exists." }, { status: 409 });
      const created = { id: `id-${table.length + 1}`, ...body };
      table.push(created);
      return Response.json([created], { status: 201 });
    }
    if (method === "PATCH") {
      const hit = table.filter(matches);
      for (const row of hit) Object.assign(row, body);
      return Response.json(hit);
    }
    return Response.json([]);
  };
  return { table, writes, restore: () => { globalThis.fetch = realFetch; } };
}

const post = (payload) => POST(new Request("https://app.example.com/api/admin/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));

const acme = {
  id: "id-acme", name: "Acme", slug: "acme", client_brief: "Sells widgets.", custom_system_prompt: "Be brief.",
  logo_url: "data:image/png;base64,AAAA", slack_internal_channel_id: "C0ACMEINT", slack_external_channel_id: "C0ACMEEXT",
  guardrails: { icp_prompt: "Heads of ops", follow_up_prompt: "Chase pricing", messaging_doc_url: "https://docs.google.com/document/d/x" },
};

test("creating a workspace whose slug is taken is refused by name, and nothing is written", async () => {
  const db = fakeDb([acme]);
  try {
    const response = await post({ create: true, name: "Acme", slug: "acme" });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(typeof payload.error, "string");
    assert.match(payload.error, /already used by Acme/);
    assert.equal(db.writes.length, 0, "the existing client must not be touched");
    assert.equal(db.table[0].client_brief, "Sells widgets.");
  } finally { db.restore(); }
});

test("a create inserts without merge-duplicates and derives a clean slug from the name", async () => {
  const db = fakeDb([acme]);
  try {
    const response = await post({ create: true, name: "Bluevia Health" });
    assert.equal(response.status, 201);
    const insert = db.writes.find((write) => write.method === "POST");
    assert.ok(insert);
    assert.doesNotMatch(insert.prefer, /merge-duplicates/);
    assert.doesNotMatch(insert.url, /on_conflict/);
    assert.equal(insert.body.slug, "bluevia-health");
    assert.equal(insert.body.webhook_url, "https://app.example.com/api/webhooks/heyreach/bluevia-health");
  } finally { db.restore(); }
});

test("on a create, a same-slug row is a collision, not 'self', for the Slack channel check too", async () => {
  const db = fakeDb([acme]);
  try {
    const response = await post({ create: true, name: "Other", slug: "other", slackInternalChannelId: "C0ACMEEXT" });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.match(payload.error, /already Acme's external channel/);
    assert.equal(db.writes.length, 0);
  } finally { db.restore(); }
});

test("a logo-only update writes the logo and nothing else", async () => {
  const db = fakeDb([acme]);
  try {
    const response = await post({ id: "id-acme", previousSlug: "acme", logoUrl: "data:image/png;base64,BBBB" });
    assert.equal(response.status, 200);
    const patch = db.writes.find((write) => write.method === "PATCH");
    assert.deepEqual(Object.keys(patch.body), ["logo_url"]);
    assert.equal(db.table[0].custom_system_prompt, "Be brief.");
    assert.equal(db.table[0].guardrails.icp_prompt, "Heads of ops");
  } finally { db.restore(); }
});

test("an /api/img reference sent back as the logo is never written over the stored image", async () => {
  const db = fakeDb([acme]);
  try {
    await post({ id: "id-acme", previousSlug: "acme", logoUrl: "/api/img/abc123", name: "Acme" });
    const patch = db.writes.find((write) => write.method === "PATCH");
    assert.equal("logo_url" in patch.body, false);
    assert.equal(db.table[0].logo_url, "data:image/png;base64,AAAA");
  } finally { db.restore(); }
});

test("guardrail keys are merged into what is stored, so another screen's prompts survive", async () => {
  const db = fakeDb([acme]);
  try {
    const response = await post({ id: "id-acme", previousSlug: "acme", guardrails: { slack_internal_only: true } });
    assert.equal(response.status, 200);
    assert.deepEqual(db.table[0].guardrails, { ...acme.guardrails, slack_internal_only: true });
  } finally { db.restore(); }
});

test("renaming to a slug another client holds is refused with that client's name", async () => {
  const db = fakeDb([acme, { id: "id-b", name: "Bluevia", slug: "bluevia", guardrails: {} }]);
  try {
    const response = await post({ id: "id-b", previousSlug: "bluevia", slug: "Acme" });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.match(payload.error, /already used by Acme/);
  } finally { db.restore(); }
});

test("a PostgREST failure reaches the page as a sentence, not an object", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if ((init.method ?? "GET") === "PATCH") return Response.json({ code: "22P02", message: "invalid input syntax for type uuid" }, { status: 400 });
    return Response.json([]);
  };
  try {
    const response = await post({ id: "id-acme", previousSlug: "acme", name: "Acme" });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error, "invalid input syntax for type uuid");
  } finally { globalThis.fetch = realFetch; }
});

test("the onboarding setup refuses a Slack channel that is another client's", async () => {
  const db = fakeDb([acme, { id: "id-b", name: "Bluevia", slug: "bluevia", guardrails: {} }]);
  try {
    const result = await saveReplyRadarConfig("bluevia", { slackInternal: "C0ACMEINT" });
    assert.equal(result.ok, false);
    assert.match(result.error, /already Acme's internal channel/);
    assert.equal(db.writes.length, 0);
    const own = await saveReplyRadarConfig("acme", { slackInternal: "C0ACMEINT" });
    assert.equal(own.ok, true, "a client keeping its own channel is not a clash");
  } finally { db.restore(); }
});

test("channel clash helpers ignore blanks and the client being saved", () => {
  const other = { name: "Coraa", slack_internal_channel_id: "C1", slack_external_channel_id: "C2" };
  assert.equal(channelClashMessage(["", null, "C9"], other), "");
  assert.match(channelClashMessage(["C2"], other), /Coraa's external channel/);
  assert.equal(firstChannelClash(["C1"], [{ id: "self", ...other }], (row) => row.id === "self"), "");
});

test("workspaceSlug keeps only lowercase letters, digits and single inner hyphens", () => {
  assert.equal(workspaceSlug("Bluevia Health"), "bluevia-health");
  assert.equal(workspaceSlug("  --Acme / Co!! "), "acme-co");
  assert.equal(workspaceSlug("***"), "");
});

test("webhookUrlFor encodes the slug as one path segment", () => {
  assert.equal(webhookUrlFor("a b/c"), "https://app.example.com/api/webhooks/heyreach/a%20b%2Fc");
});

test("safeNextPath keeps same-site paths and refuses everything that can leave the site", () => {
  const origin = "https://app.example.com";
  assert.equal(safeNextPath("/inbox?client=acme#top", origin), "/inbox?client=acme#top");
  assert.equal(safeNextPath(null, origin), "/");
  for (const hostile of ["//evil.com", "/\\evil.com", "/\\/evil.com", "https://evil.com", "evil.com", "/\t/evil.com", "javascript:alert(1)"]) {
    assert.equal(safeNextPath(hostile, origin), "/", hostile);
  }
  // What the login page actually receives for ?next=/%5Cevil.com: the query string decodes it.
  assert.equal(safeNextPath(new URLSearchParams("next=/%5Cevil.com").get("next"), origin), "/");
});
