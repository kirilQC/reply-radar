// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The inbox's data paths, run end to end against a fake Supabase.
 *
 * Every bug covered here was silent: AI state wiped by a re-ingest, a classifier's sentiment
 * overwritten by a draft, a custom range that stopped at PostgREST's 1,000-row ceiling, two
 * concurrent sends both going out. None of them threw, so the only way to keep them fixed is to
 * drive the real routes and look at what they wrote.
 *
 * The app's TypeScript imports omit the `.ts` extension (Next resolves them), so a resolve hook
 * fills it in. `fetch` is replaced for each test; nothing here reaches the network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// The routes only use `NextResponse.json`, which is the platform's `Response.json`. Standing it in
// keeps Next's server runtime out of a unit test.
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

const json = (body, status = 200) => new Response(body === null ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
/** Installs a fetch stub for one test; `handler(url, init)` returns a Response or undefined (empty 200). */
function stubFetch(t, handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (!url.startsWith(SUPABASE) && !url.startsWith("https://api.anthropic.com")) throw new Error(`Unexpected external call: ${url}`);
    return (await handler(url, init)) ?? json([]);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}
const path = (url) => decodeURIComponent(url.slice(`${SUPABASE}/rest/v1/`.length));

test("re-ingesting a conversation keeps each existing message's AI state", async (t) => {
  const { ingestHeyReachWebhook } = await import("../app/lib/heyreach-ingestion.ts");
  const writes = [];
  stubFetch(t, (url, init) => {
    const p = path(url);
    const method = init.method ?? "GET";
    if (p.startsWith("rr_webhook_events") && method === "POST") return json([{ id: "evt-1" }]);
    if (p.startsWith("rr_leads") && method === "POST") return json([{ id: "lead-1" }]);
    if (p.startsWith("rr_conversations") && method === "POST") return json([{ id: "conv-1" }]);
    if (p.startsWith("rr_messages?select=") && method === "GET") {
      return json([{ heyreach_message_id: "in-1", direction: "inbound", body: "Sounds interesting", sent_at: "2026-09-30T10:00:00Z", reply_radar: { sentiment: "positive", cached_draft: "Great, when works?", followup_urgency: 80, source: "history" } }]);
    }
    if (p.startsWith("rr_messages?on_conflict") && method === "POST") writes.push(JSON.parse(init.body));
    return undefined;
  });
  await ingestHeyReachWebhook({ url: SUPABASE, key: "service-key" }, { id: "ws-1", name: "Client" }, {
    event_type: "message_reply_received",
    conversation_id: "chat-1",
    timestamp: "2026-10-01T09:00:00Z",
    lead: { id: "lead-ext", profile_url: "https://www.linkedin.com/in/someone", full_name: "Some One" },
    sender: { id: "77", full_name: "Alex Sender" },
    campaign: { id: "c1", name: "Fall push" },
    recent_messages: [
      { id: "out-1", message: "Hi there", is_reply: false, creation_time: "2026-09-29T10:00:00Z", sender: "me" },
      { id: "in-1", message: "Sounds interesting", is_reply: true, creation_time: "2026-09-30T10:00:00Z" },
      { id: "in-2", message: "Actually, call me Monday", is_reply: true, creation_time: "2026-10-01T09:00:00Z" },
    ],
  });
  const rows = writes.flat();
  const kept = rows.find((row) => row.heyreach_message_id === "in-1");
  assert.ok(kept, "the existing message is still written");
  assert.equal(kept.raw_data.reply_radar.sentiment, "positive");
  assert.equal(kept.raw_data.reply_radar.cached_draft, "Great, when works?");
  assert.equal(kept.raw_data.reply_radar.followup_urgency, 80);
  // Fresh metadata still wins over what was stored.
  assert.equal(kept.raw_data.reply_radar.campaign.name, "Fall push");
  const fresh = rows.find((row) => row.body === "Actually, call me Monday");
  assert.equal(fresh.raw_data.reply_radar.sentiment, undefined, "a new message starts without AI state");
});

async function runAnalyze(t, storedSentiment) {
  process.env.ANTHROPIC_API_KEY = "test-key";
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const { POST } = await import("../app/api/ai/draft/route.ts");
  const patches = [];
  const calls = stubFetch(t, (url, init) => {
    if (url.startsWith("https://api.anthropic.com")) {
      return json({ content: [{ type: "text", text: JSON.stringify({ draft: "Happy to.", reason: "They asked for times.", sentiment: "negative" }) }], usage: {} });
    }
    const p = path(url);
    if (p.startsWith("rr_messages?select=id,raw_data") && p.includes("direction=eq.inbound")) {
      return json([{ id: "m-9", raw_data: { reply_radar: storedSentiment ? { sentiment: storedSentiment } : {} } }]);
    }
    if (p.startsWith("rr_messages?select=raw_data&id=eq.m-9")) {
      return json([{ raw_data: { reply_radar: storedSentiment ? { sentiment: storedSentiment } : {} } }]);
    }
    if (p.startsWith("rr_messages?id=eq.m-9") && init.method === "PATCH") patches.push(JSON.parse(init.body));
    return undefined;
  });
  const response = await POST(new Request("http://app.test/api/ai/draft", {
    method: "POST",
    body: JSON.stringify({ mode: "analyze", conversationId: "conv-1", workspaceId: "11111111-aaaa-bbbb-cccc-000000000000", thread: [{ direction: "inbound", body: "When?" }] }),
  }));
  assert.equal(response.status, 200);
  return { patches, calls };
}

test("analyze mode leaves the classifier's stored sentiment alone", async (t) => {
  const { patches } = await runAnalyze(t, "positive");
  assert.equal(patches.length, 1);
  assert.equal(patches[0].raw_data.reply_radar.sentiment, "positive");
  assert.equal(patches[0].raw_data.reply_radar.cached_draft, "Happy to.");
});

test("analyze mode fills sentiment only when none was stored, and reads tone examples newest first", async (t) => {
  const { patches, calls } = await runAnalyze(t, "");
  assert.equal(patches[0].raw_data.reply_radar.sentiment, "negative");
  const toneQuery = calls.map((call) => path(call.url)).find((p) => p.startsWith("rr_conversations?select=id,lead_id"));
  assert.match(toneQuery, /order=last_message_at\.desc/);
});

test("a custom inbox range pages past PostgREST's 1,000-row ceiling", async (t) => {
  const { GET } = await import("../app/api/inbox/route.ts");
  const conversationPages = [];
  const messagePages = [];
  stubFetch(t, (url) => {
    const p = path(url);
    if (p.startsWith("rr_workspaces")) return json([{ id: "ws-1", name: "Client", slug: "client" }]);
    if (p.startsWith("rr_leads")) return json([{ id: "l-1", name: "Some One", raw_data: {} }]);
    if (p.startsWith("rr_conversations")) {
      const offset = Number(p.match(/offset=(\d+)/)?.[1] ?? 0);
      const limit = Number(p.match(/limit=(\d+)/)?.[1] ?? 0);
      conversationPages.push({ offset, limit });
      assert.ok(limit <= 1000, "never asks for more than PostgREST will return");
      // Behave like PostgREST: hand back the full page every time, there are more than 2,000 rows.
      return json(Array.from({ length: limit }, (_, i) => ({ id: `c-${offset + i}`, workspace_id: "ws-1", lead_id: "l-1", last_message_at: "2026-09-01T00:00:00Z" })));
    }
    if (p.startsWith("rr_messages")) {
      const offset = Number(p.match(/offset=(\d+)/)?.[1] ?? 0);
      messagePages.push(offset);
      return json(offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: `m-${i}`, conversation_id: "c-0", body: `m${i}`, direction: "outbound", sent_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() })) : []);
    }
    return undefined;
  });
  const response = await GET(new Request("http://app.test/api/inbox?since=2026-08-01T00:00:00Z"));
  assert.equal(response.status, 200);
  assert.deepEqual(conversationPages, [{ offset: 0, limit: 1000 }, { offset: 1000, limit: 1000 }], "stops at 2,000 rows");
  assert.ok(messagePages.includes(1000), "a full message page is followed by another");
});

test("two concurrent sends of the same reply reach HeyReach once", async (t) => {
  const { POST } = await import("../app/api/conversations/reply/route.ts");
  const locks = new Map();
  let heyReachSends = 0;
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/inbox/SendMessage")) {
      heyReachSends += 1;
      await sendGate;
      return json({});
    }
    if (!url.startsWith(SUPABASE)) throw new Error(`Unexpected external call: ${url}`);
    const p = path(url);
    const method = init.method ?? "GET";
    if (p.startsWith("rr_conversations?select")) return json([{ id: "conv-1", workspace_id: "ws-1", heyreach_conversation_id: "chat-1::c1::77", account_id: "77" }]);
    if (p.startsWith("rr_workspaces")) return json([{ id: "ws-1", name: "Client", heyreach_api_key_ciphertext: "hr-key" }]);
    if (p === "rr_app_config" && method === "POST") {
      const { key } = JSON.parse(init.body);
      if (locks.has(key)) return json({ code: "23505" }, 409);
      locks.set(key, { updated_at: "2026-10-02T00:00:00.000000+00:00" });
      return json(null, 201);
    }
    if (p.startsWith("rr_app_config?key=eq.") && method === "DELETE") {
      locks.delete(p.match(/key=eq\.([^&]+)/)[1]);
      return json(null, 204);
    }
    return json([]);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const send = () => POST(new Request("http://app.test/api/conversations/reply", { method: "POST", body: JSON.stringify({ conversationId: "conv-1", message: "Monday at 2 works.", confirm: "send" }) }));
  const first = send();
  // Let the first request take the lock and reach HeyReach before the second arrives.
  while (heyReachSends === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = await send();
  releaseSend();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  assert.equal(second.status, 409);
  assert.equal(heyReachSends, 1);
  assert.equal(locks.size, 0, "the lock is released once the send is recorded");
});

test("refresh reads the real chatroom for suffixed ids, dedupes the thread, and trusts only a full read", async (t) => {
  const { POST } = await import("../app/api/conversations/refresh/route.ts");
  const chatroomPaths = [];
  const leadPatches = [];
  const sentAt = "2026-10-02T12:00:00.000Z";
  const echoedAt = "2026-10-02T12:00:20.000Z";
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/inbox/GetChatroom/")) {
      chatroomPaths.push(url.split("/inbox/GetChatroom/")[1]);
      return json({ messages: [{ id: "hr-9", message: "See you Monday", sender: "me", createdAt: echoedAt }] });
    }
    if (!url.startsWith(SUPABASE)) throw new Error(`Unexpected external call: ${url}`);
    const p = path(url);
    const method = init.method ?? "GET";
    if (p.startsWith("rr_conversations?select")) return json([{ id: "conv-1", workspace_id: "ws-1", lead_id: "lead-1", heyreach_conversation_id: "chat-1::c1::77", account_id: "77" }]);
    if (p.startsWith("rr_workspaces")) return json([{ id: "ws-1", heyreach_api_key_ciphertext: "hr-key" }]);
    if (p.startsWith("rr_leads?select=linkedin_profile_url")) return json([{ linkedin_profile_url: "https://www.linkedin.com/in/someone", raw_data: { reply_radar: { history_status: "webhook_fallback" } } }]);
    if (p.startsWith("rr_leads?select=name")) return json([{ name: "Some One" }]);
    if (p.startsWith("rr_leads?id=eq.") && method === "PATCH") leadPatches.push(JSON.parse(init.body));
    if (p.startsWith("rr_messages?select=id,conversation_id")) {
      return json([
        { id: "a", conversation_id: "conv-1", body: "See you Monday", direction: "outbound", sent_at: sentAt, raw_data: { reply_radar: { source: "reply_radar_send" } } },
        { id: "b", conversation_id: "conv-1", body: "See you Monday", direction: "outbound", sent_at: echoedAt, raw_data: { reply_radar: { source: "refresh" } } },
      ]);
    }
    return json([]);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const response = await POST(new Request("http://app.test/api/conversations/refresh", { method: "POST", body: JSON.stringify({ conversationId: "conv-1" }) }));
  const payload = await response.json();
  assert.deepEqual(chatroomPaths, ["77/chat-1"], "the ::campaign::sender suffix is stripped");
  assert.equal(payload.results[0].thread.length, 1, "a just-sent reply and HeyReach's echo show once");
  assert.equal(leadPatches[0]?.raw_data.reply_radar.history_status, "complete");
});

test("refresh does not mark history complete from the GetConversationsV2 fallback", async (t) => {
  const { POST } = await import("../app/api/conversations/refresh/route.ts");
  const leadPatches = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/inbox/GetChatroom/")) return json({}, 404);
    if (url.includes("/inbox/GetConversationsV2")) return json({ items: [{ id: "chat-1", messages: [{ id: "hr-1", message: "Latest only", sender: "lead", createdAt: "2026-10-02T09:00:00Z" }] }] });
    if (!url.startsWith(SUPABASE)) throw new Error(`Unexpected external call: ${url}`);
    const p = path(url);
    if (p.startsWith("rr_conversations?select")) return json([{ id: "conv-1", workspace_id: "ws-1", lead_id: "lead-1", heyreach_conversation_id: "chat-1", account_id: "77" }]);
    if (p.startsWith("rr_workspaces")) return json([{ id: "ws-1", heyreach_api_key_ciphertext: "hr-key" }]);
    if (p.startsWith("rr_leads?select=linkedin_profile_url")) return json([{ linkedin_profile_url: "https://www.linkedin.com/in/someone", raw_data: {} }]);
    if (p.startsWith("rr_leads?id=eq.") && init.method === "PATCH") leadPatches.push(JSON.parse(init.body));
    return json([]);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  await POST(new Request("http://app.test/api/conversations/refresh", { method: "POST", body: JSON.stringify({ conversationId: "conv-1" }) }));
  assert.equal(leadPatches.length, 0);
});
