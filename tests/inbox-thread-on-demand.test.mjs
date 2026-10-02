// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The inbox list is thread-less; the open conversation's thread is read on demand.
 *
 * /api/inbox used to ship every conversation's whole thread (~3.5MB for ~1,000 rows) on each load,
 * though only the open conversation ever shows one. These tests pin the split: the list carries what
 * the list, filters and merge logic read (who spoke last, which reply AI state belongs to, a short
 * preview), and `?conversationId=` returns the full thread plus the cached draft, built the same way.
 * Driven against a fake Supabase; nothing reaches the network.
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
const path = (url) => decodeURIComponent(url.slice(`${SUPABASE}/rest/v1/`.length));

const CONVERSATIONS = 40;
const MESSAGES_PER_THREAD = 8;
const longBody = (seed) => `Message ${seed}. ${"We help revenue teams book more qualified meetings without adding headcount. ".repeat(6)}`;
const conversationRows = Array.from({ length: CONVERSATIONS }, (_, i) => ({
  id: `c-${i}`,
  workspace_id: "ws-1",
  lead_id: `l-${i}`,
  last_message_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  score: 50,
  tier: "warm",
}));
const leadRows = conversationRows.map((row, i) => ({
  id: row.lead_id,
  name: `Lead ${i}`,
  raw_data: { reply_radar: { history_status: "complete", campaign: { id: "camp-1", name: "Q3 Outbound" } } },
}));
/** Rows shaped like the narrowed select returns them: `reply_radar` aliased out of `raw_data`. */
const messageRows = conversationRows.flatMap((row, c) =>
  Array.from({ length: MESSAGES_PER_THREAD }, (_, m) => ({
    id: `m-${c}-${m}`,
    conversation_id: row.id,
    body: longBody(`${c}-${m}`),
    // Outbound first (we opened), alternating, so the newest message is the lead's.
    direction: m % 2 === 0 ? "outbound" : "inbound",
    sent_at: new Date(Date.UTC(2026, 7, 1, c, m)).toISOString(),
    reply_radar:
      m === MESSAGES_PER_THREAD - 1
        ? { sentiment: "positive", analyzed_at: "2026-09-02T00:00:00Z", cached_draft: "Happy to set up a call, does Tuesday work?", cached_reason: "Asked for times." }
        : m === 0
          ? { sender: { name: "Kiril" }, campaign: { id: "camp-1", name: "Q3 Outbound" } }
          : null,
  })),
);

function stubSupabase(t) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.startsWith(SUPABASE)) throw new Error(`Unexpected external call: ${url}`);
    const p = path(url);
    calls.push(p);
    if (p.startsWith("rr_workspaces")) return json([{ id: "ws-1", name: "Client", slug: "client" }]);
    if (p.startsWith("rr_conversations?select=*&id=eq.")) {
      const id = p.match(/id=eq\.([^&]+)/)[1];
      return json(conversationRows.filter((row) => row.id === id));
    }
    if (p.startsWith("rr_conversations")) {
      const offset = Number(p.match(/offset=(\d+)/)?.[1] ?? 0);
      return json(offset ? [] : conversationRows);
    }
    if (p.startsWith("rr_leads")) {
      const single = p.match(/id=eq\.([^&]+)/)?.[1];
      return json(single ? leadRows.filter((row) => row.id === single) : leadRows);
    }
    if (p.startsWith("rr_messages")) {
      const offset = Number(p.match(/offset=(\d+)/)?.[1] ?? 0);
      if (offset) return json([]);
      const single = p.match(/conversation_id=eq\.([^&]+)/)?.[1];
      return json(single ? messageRows.filter((row) => row.conversation_id === single) : messageRows);
    }
    return json([]);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

test("the inbox list carries no threads, only what the list and its filters read", async (t) => {
  const { GET } = await import("../app/api/inbox/route.ts");
  const calls = stubSupabase(t);
  const response = await GET(new Request("http://app.test/api/inbox?workspaces=client"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.conversations.length, CONVERSATIONS);
  const row = payload.conversations.find((item) => item.id === "c-3");
  assert.equal(row.messages, undefined, "no thread on a list row");
  assert.equal(row.cachedDraft, undefined, "the draft text comes with the thread");
  assert.equal(row.lastDirection, "inbound");
  assert.equal(row.latestInboundId, "m-3-7");
  assert.equal(row.latestInboundAt, messageRows.find((m) => m.id === "m-3-7").sent_at);
  assert.equal(row.messageCount, MESSAGES_PER_THREAD);
  assert.equal(row.replies, MESSAGES_PER_THREAD / 2);
  assert.ok(row.preview.length <= 280, "preview is trimmed");
  assert.ok(row.preview.startsWith("Message 3-7."));
  // What the queue's filters, sorts and badges read is all still there.
  assert.equal(row.sentiment, "positive");
  assert.equal(row.analyzedAt, "2026-09-02T00:00:00Z");
  assert.equal(row.senderName, "Kiril");
  assert.equal(row.campaignName, "Q3 Outbound");
  assert.equal(row.hasCampaign, true);
  assert.equal(typeof row.followUpUrgency, "number");
  assert.equal(row.tier, "warm");
  // The message read asks for the reply_radar key, not every message's whole raw_data.
  const messageQuery = calls.find((p) => p.startsWith("rr_messages"));
  assert.match(messageQuery, /select=id,conversation_id,body,direction,sent_at,reply_radar:raw_data->reply_radar&/);
});

test("?conversationId= returns that conversation's full thread and cached draft", async (t) => {
  const { GET } = await import("../app/api/inbox/route.ts");
  stubSupabase(t);
  const response = await GET(new Request("http://app.test/api/inbox?conversationId=c-5"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.thread.length, MESSAGES_PER_THREAD);
  assert.deepEqual(Object.keys(payload.thread[0]).sort(), ["authorName", "body", "direction", "id", "sentAt"]);
  assert.equal(payload.thread[0].authorName, "Kiril");
  assert.equal(payload.thread[1].authorName, "Lead 5");
  assert.equal(payload.thread.at(-1).body, longBody("5-7"), "bodies are whole, not previews");
  assert.equal(payload.cachedDraft, "Happy to set up a call, does Tuesday work?");
  assert.equal(payload.cachedReason, "Asked for times.");
  assert.equal(payload.analyzedAt, "2026-09-02T00:00:00Z");
});

test("an unknown conversation id answers not-found rather than an empty success", async (t) => {
  const { GET } = await import("../app/api/inbox/route.ts");
  stubSupabase(t);
  const payload = await (await GET(new Request("http://app.test/api/inbox?conversationId=nope"))).json();
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.thread, []);
});

test("the list is a fraction of the bytes it was with threads inlined", async (t) => {
  const { GET } = await import("../app/api/inbox/route.ts");
  stubSupabase(t);
  const list = await (await GET(new Request("http://app.test/api/inbox?workspaces=client"))).json();
  const listBytes = Buffer.byteLength(JSON.stringify(list));
  // The old payload was each row plus its thread and draft; rebuild it from the thread endpoint.
  let threadBytes = 0;
  for (const row of list.conversations) {
    const detail = await (await GET(new Request(`http://app.test/api/inbox?conversationId=${row.id}`))).json();
    threadBytes += Buffer.byteLength(JSON.stringify({ messages: detail.thread, cachedDraft: detail.cachedDraft, cachedReason: detail.cachedReason }));
  }
  assert.ok(listBytes < (listBytes + threadBytes) * 0.35, `list ${listBytes}B vs ${listBytes + threadBytes}B with threads`);
});
