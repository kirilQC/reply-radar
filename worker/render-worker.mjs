// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { classifyConversationOrigin } from "../shared/conversation-origin.mjs";
import { directionFor, extractMessageRows, messageKey, syntheticMessageId } from "../shared/message-identity.mjs";

/**
 * Render Background Worker entrypoint.
 *
 * This process deliberately owns only server-side synchronization. The Next.js
 * app remains responsible for the UI and webhook route; this worker keeps the
 * Supabase heartbeat fresh and verifies each configured HeyReach connection.
 */
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const heyreachBase = (process.env.HEYREACH_API_BASE || "https://api.heyreach.io/api/public").replace(/\/$/, "");
const pollIntervalMs = Math.max(30, Number(process.env.POLL_INTERVAL_SECONDS || 120)) * 1000;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "content-type": "application/json" };

async function supabase(path, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${body}`);
  if (!body.trim()) return null;
  try { return JSON.parse(body); } catch { return body; }
}

async function checkHeyReach(apiKey) {
  const response = await fetch(`${heyreachBase}/auth/CheckApiKey`, { headers: { "X-API-KEY": apiKey, accept: "application/json" } });
  const body = await response.text();
  const contentType = response.headers.get("content-type") || "unknown content type";
  if (!response.ok) throw new Error(`HeyReach ${response.status} (${contentType}): ${body.slice(0, 500) || "empty response"}`);
  if (body.trim() && !contentType.toLowerCase().includes("application/json")) throw new Error(`HeyReach returned ${contentType}: ${body.slice(0, 500)}`);
  if (body.trim()) {
    try { JSON.parse(body); } catch { throw new Error(`HeyReach returned invalid JSON: ${body.slice(0, 500)}`); }
  }
}

async function writeSyncRun(payload) {
  try {
    return await supabase("rr_sync_runs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(payload) });
  } catch (error) {
    // Installations created from the original schema have no run_type column;
    // a later production variant made it required. Retry only when PostgREST
    // explicitly reports that this optional compatibility column is absent.
    if ("run_type" in payload && error instanceof Error && /run_type.*(column|schema cache)|column.*run_type/i.test(error.message)) {
      const legacyPayload = { ...payload };
      delete legacyPayload.run_type;
      console.warn("reply_radar_sync_run_legacy_schema", { omittedColumn: "run_type", error: error.message });
      return supabase("rr_sync_runs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(legacyPayload) });
    }
    throw error;
  }
}

/**
 * Stamps a fresh worker heartbeat. The health page reads the newest heartbeat row's `started_at`
 * and calls the worker stale after five minutes, so long-running background work has to say it is
 * still alive as it goes — otherwise a worker busy analysing replies reports itself as down.
 */
async function touchHeartbeat() {
  const now = new Date().toISOString();
  await writeSyncRun({ workspace_id: null, run_type: "heartbeat", source: "render-worker-heartbeat", status: "success", started_at: now, finished_at: now, records_seen: 0, records_written: 0 })
    .catch((error) => console.warn("reply_radar_heartbeat_touch_failed", { reason: error instanceof Error ? error.message : String(error) }));
}

async function syncWorkspace(workspace) {
  const startedAt = new Date().toISOString();
  let status = "success";
  let errorText = null;
  let recordsSeen = 0;
  try {
    if (!workspace.heyreach_api_key_ciphertext) throw new Error("HeyReach API key is not configured");
    // API keys are expected to be encrypted at rest in production. Until the
    // encryption provider is configured, this supports a server-side value.
    await checkHeyReach(workspace.heyreach_api_key_ciphertext);
    await supabase(`rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_successful_poll_at: new Date().toISOString() }) });
  } catch (error) {
    status = "failed";
    errorText = error instanceof Error ? error.message : "Workspace sync failed";
  }
  await writeSyncRun({ workspace_id: workspace.id, run_type: "workspace-sync", source: "render-worker", status, started_at: startedAt, finished_at: new Date().toISOString(), records_seen: recordsSeen, records_written: 0, error_text: errorText });
  // The error key is omitted when there is nothing wrong: Render's log viewer flags any line
  // containing "error" as a failure, so `error: null` painted every healthy sync run red.
  console.info("reply_radar_workspace_sync", { workspace: workspace.slug, status, ...(errorText ? { error: errorText } : {}) });
}

// ── Conversation refresh ────────────────────────────────────────────
// Background Tier 3 refresh: pick the 5 oldest conversations per workspace every
// ~2.4h so each client gets ~50 refreshes/day, staggered instead of a single spike.
// Dormant threads (no message in 30 days) are skipped — they aren't going anywhere.
const REFRESH_LOOP_MS = Math.round(2.4 * 60 * 60 * 1000);
const REFRESH_STALENESS_MS = REFRESH_LOOP_MS;
const REFRESH_BATCH_SIZE = 5;
const REFRESH_DORMANT_DAYS = 30;
let lastRefreshRun = 0;

async function heyReachFetch(apiKey, path, init = {}) {
  const response = await fetch(`${heyreachBase}/${path.replace(/^\//, "")}`, {
    ...init,
    headers: { "X-API-KEY": apiKey, accept: "application/json", "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HeyReach ${path.split("?")[0]} ${response.status}`);
  return response.json().catch(() => null);
}

async function refreshConversation(workspace, conv) {
  const apiKey = workspace.heyreach_api_key_ciphertext;
  const accountId = String(conv.account_id || "");
  const heyreachConvId = String(conv.heyreach_conversation_id || "");
  if (!accountId || !heyreachConvId) return 0;

  // Get lead profile URL
  const leads = conv.lead_id ? await supabase(`rr_leads?select=linkedin_profile_url,raw_data&id=eq.${encodeURIComponent(conv.lead_id)}&limit=1`) : [];
  const profileUrl = String((leads && leads[0]?.linkedin_profile_url) || "");
  const leadRaw = (leads && leads[0] && leads[0].raw_data) || {};

  let chatroom = null;
  try {
    chatroom = await heyReachFetch(apiKey, `inbox/GetChatroom/${encodeURIComponent(accountId)}/${encodeURIComponent(heyreachConvId)}`, { method: "GET" });
  } catch {
    if (!profileUrl) return 0;
    try {
      const numericAccount = /^\d+$/.test(accountId) ? Number(accountId) : accountId;
      const list = await heyReachFetch(apiKey, "inbox/GetConversationsV2", { method: "POST", body: JSON.stringify({ offset: 0, limit: 10, filters: { linkedInAccountIds: [numericAccount], leadProfileUrl: profileUrl } }) });
      const items = Array.isArray(list) ? list : (list && Array.isArray(list.items) ? list.items : []);
      if (items.length) chatroom = items[0];
    } catch { return 0; }
  }
  if (!chatroom) return 0;

  const now = new Date().toISOString();
  const messages = extractMessageRows(chatroom).map((row) => {
    const direction = directionFor(row, accountId);
    const sentAtRaw = row.creation_time || row.creationTime || row.createdAt || row.sentAt || row.timestamp;
    const parsed = new Date(String(sentAtRaw || ""));
    const sentAt = Number.isNaN(parsed.getTime()) ? now : parsed.toISOString();
    const body = String(row.message || row.body || row.text || row.content || row.messageText || row.messageBody || "[Empty message]").trim();
    const suppliedId = String(row.id || row.messageId || row.message_id || row.linkedinMessageId || "");
    return { externalId: suppliedId || syntheticMessageId(sentAt, body), direction, body, sentAt };
  });

  const existing = await supabase(`rr_messages?select=id,heyreach_message_id,direction,body,sent_at,raw_data&conversation_id=eq.${encodeURIComponent(conv.id)}&limit=5000`);
  // Keyed without the direction so a message we previously misattributed is recognised and
  // corrected rather than inserted a second time as if the other party had sent it.
  const existingByKey = new Map();
  for (const row of existing || []) {
    const identity = messageKey(row.sent_at, row.body);
    existingByKey.set(identity, [...(existingByKey.get(identity) || []), row]);
  }

  // Only insert genuinely NEW messages. Upserting an existing row would replace its
  // raw_data wholesale, destroying sentiment, cached drafts, follow-up scores and
  // sender/campaign attribution. Mirrors app/api/conversations/refresh/route.ts.
  const records = messages
    .filter((m) => !existingByKey.has(messageKey(m.sentAt, m.body)))
    .map((m) => ({
      conversation_id: conv.id,
      heyreach_message_id: m.externalId,
      direction: m.direction,
      body: m.body,
      sent_at: m.sentAt,
      raw_data: { reply_radar: { source: "refresh", refreshed_at: now } },
    }));

  if (records.length) {
    for (let i = 0; i < records.length; i += 200) {
      await supabase("rr_messages?on_conflict=conversation_id,heyreach_message_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(records.slice(i, i + 200)),
      });
    }
  }

  // Repair rows an earlier release stored with the wrong direction, or stored twice because
  // its dedupe key included the direction. Correct the copy worth keeping, drop the rest.
  for (const message of messages) {
    const rows = existingByKey.get(messageKey(message.sentAt, message.body));
    if (!rows || !rows.length) continue;
    // Keep whichever row carries AI state, so sentiment, drafts and scores survive the repair.
    const keep = rows.find((row) => {
      const radar = (row.raw_data && row.raw_data.reply_radar) || {};
      return ["sentiment", "cached_draft", "followup_urgency", "analyzed_at"].some((field) => radar[field] != null);
    }) || rows[0];
    if (String(keep.direction) !== message.direction) {
      await supabase(`rr_messages?id=eq.${encodeURIComponent(String(keep.id))}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ direction: message.direction }),
      }).catch(() => null);
    }
    for (const row of rows) {
      if (row === keep) continue;
      await supabase(`rr_messages?id=eq.${encodeURIComponent(String(row.id))}`, {
        method: "DELETE", headers: { Prefer: "return=minimal" },
      }).catch(() => null);
    }
  }

  /*
   * A lead stored from the webhook alone is holding the newest messages only, so nothing can say who
   * spoke first and the origin check has to abstain — which means an inbound-first conversation that
   * arrived while HeyReach was unreachable sits in the inbox indefinitely.
   *
   * Reading the chatroom is what ends that. The full thread is now stored, so the lead is marked
   * complete and the next purge judges it on real evidence. Mirrors app/api/conversations/refresh,
   * which did this already — but that only runs when somebody opens the conversation, and the point
   * of the worker is that nobody has to.
   */
  if (messages.length && String((leadRaw.reply_radar || {}).history_status || "") !== "complete" && conv.lead_id) {
    await supabase(`rr_leads?id=eq.${encodeURIComponent(conv.lead_id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ raw_data: { ...leadRaw, reply_radar: { ...(leadRaw.reply_radar || {}), history_status: "complete", history_fetched_at: now } } }),
    }).catch(() => null);
  }

  const latest = [...messages].sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
  if (latest) {
    await supabase(`rr_conversations?id=eq.${encodeURIComponent(conv.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_message_at: latest.sentAt, last_message_direction: latest.direction, last_refreshed_at: now }),
    });
  }

  return records.length;
}

async function refreshAllConversations() {
  const startedAt = new Date().toISOString();
  console.info("reply_radar_conversation_refresh_started");
  const workspaces = await supabase("rr_workspaces?select=id,slug,heyreach_api_key_ciphertext&order=created_at.asc");
  let totalRefreshed = 0;
  let totalErrors = 0;

  for (const workspace of workspaces) {
    if (!workspace.heyreach_api_key_ciphertext) continue;
    const cutoff = new Date(Date.now() - REFRESH_STALENESS_MS).toISOString();
    const dormantCutoff = new Date(Date.now() - REFRESH_DORMANT_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // Two filters: not-recently-refreshed AND not-dormant. Dormant threads (last
    // message older than 30d) rarely change and would eat the daily budget for
    // rows that actually move.
    const conversations = await supabase(
      `rr_conversations?select=id,lead_id,account_id,heyreach_conversation_id&workspace_id=eq.${encodeURIComponent(workspace.id)}&or=(last_refreshed_at.is.null,last_refreshed_at.lt.${encodeURIComponent(cutoff)})&last_message_at=gte.${encodeURIComponent(dormantCutoff)}&order=last_refreshed_at.asc.nullsfirst&limit=${REFRESH_BATCH_SIZE}`,
    );
    if (!conversations || !conversations.length) continue;

    for (const conv of conversations) {
      try {
        const count = await refreshConversation(workspace, conv);
        if (count > 0) totalRefreshed++;
      } catch (error) {
        totalErrors++;
        console.warn("reply_radar_conversation_refresh_error", { workspace: workspace.slug, conversation: conv.id, error: error instanceof Error ? error.message : String(error) });
      }
      // Be gentle on HeyReach API
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.info("reply_radar_workspace_conversations_refreshed", { workspace: workspace.slug, batch: conversations.length });
  }

  await writeSyncRun({ workspace_id: null, run_type: "conversation-refresh", source: "render-worker", status: totalErrors > 0 ? "partial" : "success", started_at: startedAt, finished_at: new Date().toISOString(), records_seen: totalRefreshed + totalErrors, records_written: totalRefreshed, error_text: totalErrors > 0 ? `${totalErrors} conversations failed to refresh` : null });
  console.info("reply_radar_conversation_refresh_finished", { totalRefreshed, totalErrors });
}

// ── Inbound-lead auto purge ─────────────────────────────────────────
// Ingestion refuses leads who messaged us first, but rows that pre-date that guard — or
// that got past an earlier, looser version of it — still sit in the database. Every ~1h
// the worker calls the purge route with `confirm: true` so they clean themselves out.
// This is the only thing that runs the purge now; the admin button for it is gone,
// because relying on somebody to remember is how the noise built up in the first place.
const PURGE_LOOP_MS = 60 * 60 * 1000;
let lastPurgeRun = 0;

async function purgeInboundLeads() {
  if (!appBaseUrl) return;
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(`${appBaseUrl}/api/database/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
      signal: AbortSignal.timeout(120_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`purge ${response.status}: ${String(payload.error || "").slice(0, 200)}`);
    const deleted = payload.deleted || {};
    await writeSyncRun({
      workspace_id: null,
      run_type: "inbound-purge",
      source: "render-worker",
      status: "success",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      records_seen: Number(payload.scannedConversations || 0),
      records_written: Number(deleted.conversations || 0) + Number(deleted.leads || 0),
    });
    if (deleted.conversations || deleted.leads) {
      console.info("reply_radar_inbound_purge", { leads: deleted.leads, conversations: deleted.conversations, messages: deleted.messages });
    }
  } catch (error) {
    console.warn("reply_radar_inbound_purge_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

// ── AI pipeline ─────────────────────────────────────────────────────
/**
 * Every reply should already be scored and drafted by the time somebody opens the inbox, so
 * the worker sweeps for replies with missing AI state instead of waiting for a browser to
 * trigger the work.
 *
 * The Anthropic key, the prompts and the persistence rules all live in the Next.js app, so
 * this calls its existing routes rather than reimplementing them here — and those routes
 * already refuse to redo work that is cached, which is what stops a sweep from re-billing.
 */
// APP_BASE_URL is typed into the Render dashboard by hand, and a hostname pasted without a scheme
// ("reply-radar.vercel.app") makes every fetch fail with "Failed to parse URL" — which reads like a
// bug in the sweep rather than a missing "https://". The scheme is assumed instead of demanded.
const appBaseUrl = (() => {
  const configured = (process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!configured) return "";
  const withScheme = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    console.error("reply_radar_app_base_url_invalid", { value: configured.slice(0, 200) });
    return "";
  }
})();
// Conversations put through the pipeline per client per cycle. Each costs up to three Anthropic
// calls, so this bounds both spend and how long one client can hold the sweep.
const AI_BATCH_SIZE = Math.max(1, Number(process.env.AI_BATCH_SIZE || 10));
// How far back to look for replies that still need work, newest reply first.
const AI_CANDIDATE_LIMIT = 200;
// Conversations analysed at the same time. Each conversation is three sequential Anthropic calls
// that mostly sit waiting, so a handful in flight multiplies throughput without bursting the API.
const AI_CONCURRENCY = Math.max(1, Number(process.env.AI_CONCURRENCY || 4));
// Wall clock the sweep may use before it stops starting new work and lets the cycle finish. The
// backlog is worked down over successive cycles instead of one cycle running away with the
// process, which would delay every HeyReach connection check behind it.
const AI_CYCLE_BUDGET_MS = Math.max(30, Number(process.env.AI_CYCLE_BUDGET_SECONDS || 600)) * 1000;
// A lead AI Ark could not match is left alone for a week. AI Ark bills five attempts per call,
// so retrying every cycle would spend real money re-learning the same answer.
const ENRICHMENT_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
let missingBaseUrlWarned = false;
// Slug of the client the previous cycle ran out of budget on, so the next cycle resumes there
// rather than restarting at the first client and starving the rest of the list forever.
let aiWorkspaceCursor = "";

const radarOf = (rawData) => {
  const raw = rawData && typeof rawData === "object" ? rawData : {};
  return raw.reply_radar && typeof raw.reply_radar === "object" ? raw.reply_radar : {};
};

async function appPost(path, body) {
  const response = await fetch(`${appBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} ${response.status}: ${String(payload.error || "").slice(0, 200)}`);
  return payload;
}

async function chunked(ids, size, run) {
  const rows = [];
  for (let i = 0; i < ids.length; i += size) {
    const batch = await run(ids.slice(i, i + size));
    if (batch) rows.push(...batch);
  }
  return rows;
}

/**
 * Runs `task` over `items` with at most `limit` of them in flight. Deliberately minimal: the sweep
 * only needs the waiting overlapped, and nothing downstream cares what order they finish in.
 */
async function inParallel(items, limit, task) {
  let next = 0;
  const runner = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

/**
 * A lead is worth enriching once, if AI Ark can identify them at all. Enrichment supplies the
 * headline, industry, company size and profile photo, so it runs before ICP scoring — and the
 * ICP score is kept forever, which makes it worth scoring against the fuller picture.
 */
function needsEnrichment(lead) {
  if (!lead || !String(lead.linkedin_profile_url || "").trim()) return false;
  const radar = radarOf(lead.raw_data);
  if (radar.ai_ark) return false;
  const attemptedAt = Date.parse(String(radar.enrichment_attempted_at || ""));
  return Number.isNaN(attemptedAt) || Date.now() - attemptedAt > ENRICHMENT_RETRY_MS;
}

/** Replies whose enrichment, draft, sentiment, ICP score or follow-up score is still missing. */
async function conversationsNeedingAi(workspace) {
  // Deliberately not filtered on last_message_direction. That column says who spoke *last*, so
  // filtering on "inbound" silently excluded every conversation a teammate had already replied
  // to, plus every row where the column was never populated — which is most of the inbox. What
  // qualifies a conversation is that the lead replied at all, and that is checked below.
  const candidates = await supabase(
    `rr_conversations?select=id,lead_id&workspace_id=eq.${encodeURIComponent(workspace.id)}&order=last_message_at.desc.nullslast&limit=${AI_CANDIDATE_LIMIT}`,
  );
  if (!candidates || !candidates.length) return { work: [], leadsById: new Map() };

  // Every message, not just the inbound ones: per-reply AI state lives on the newest inbound
  // message, but deciding whether the lead approached us needs the *first* message and the campaign
  // attribution that any message may carry. Batched small with an explicit ceiling, because
  // PostgREST caps rows per request and a truncated page here would hide a conversation's newest
  // reply and stall it out of the sweep every cycle.
  const allMessages = await chunked(candidates.map((c) => c.id), 20, (batch) =>
    supabase(`rr_messages?select=conversation_id,direction,sent_at,raw_data&conversation_id=in.(${batch.join(",")})&order=sent_at.desc&limit=5000`),
  );
  const messagesByConversation = new Map();
  const latestInbound = new Map();
  for (const row of allMessages) {
    const id = String(row.conversation_id);
    const rows = messagesByConversation.get(id);
    if (rows) rows.push(row);
    else messagesByConversation.set(id, [row]);
    // Newest first from the query, so the first inbound row seen is the latest one.
    if (String(row.direction) === "inbound" && !latestInbound.has(id)) latestInbound.set(id, row);
  }

  // Enrichment and the ICP score are both stored on the lead and kept, so each happens once.
  const leadIds = [...new Set(candidates.map((c) => String(c.lead_id || "")).filter(Boolean))];
  const leads = await chunked(leadIds, 40, (batch) =>
    supabase(`rr_leads?select=id,name,linkedin_profile_url,raw_data&id=in.(${batch.join(",")})`),
  );
  const leadsById = new Map(leads.map((lead) => [String(lead.id), lead]));

  const work = [];
  for (const conv of candidates) {
    const latest = latestInbound.get(String(conv.id));
    if (!latest) continue;
    const radar = radarOf(latest.raw_data);
    const lead = leadsById.get(String(conv.lead_id || ""));
    // Someone who approached us is not part of the outbound motion the inbox works, and the inbox
    // sets them aside. Scoring and drafting for them would be money spent on a row nobody sees.
    if (classifyConversationOrigin({ messages: messagesByConversation.get(String(conv.id)) || [], leadRawData: lead && lead.raw_data }).origin === "inbound_lead") continue;
    // A draft is stale once it predates the reply it was supposed to answer.
    const analyzedAt = Date.parse(String(radar.analyzed_at || ""));
    const needsReview = !radar.cached_draft || Number.isNaN(analyzedAt) || analyzedAt <= Date.parse(String(latest.sent_at));
    const needsFollowUp = !radar.followup_analyzed_at;
    const needsIcp = Boolean(lead) && radarOf(lead.raw_data).icp_score == null;
    const needsEnrich = needsEnrichment(lead);
    if (!needsReview && !needsFollowUp && !needsIcp && !needsEnrich) continue;
    work.push({ conv, needsReview, needsFollowUp, needsIcp, needsEnrich, sentiment: String(radar.sentiment || "") });
    if (work.length >= AI_BATCH_SIZE) break;
  }
  return { work, leadsById };
}

async function runAiForConversation(workspace, item, leadName) {
  const guardrails = workspace.guardrails && typeof workspace.guardrails === "object" ? workspace.guardrails : {};
  const rows = await supabase(
    `rr_messages?select=direction,body,sent_at,raw_data&conversation_id=eq.${encodeURIComponent(item.conv.id)}&order=sent_at.asc&limit=200`,
  );
  const thread = (rows || []).map((row) => ({ direction: String(row.direction || ""), body: String(row.body || ""), sentAt: String(row.sent_at || "") }));
  if (!thread.length) return 0;
  const campaignName = (rows || [])
    .map((row) => String((radarOf(row.raw_data).campaign || {}).name || ""))
    .find(Boolean);

  const shared = { workspaceId: workspace.id, workspaceName: String(workspace.name || workspace.slug || ""), leadName };
  let steps = 0;
  let sentiment = item.sentiment;

  // Enrichment first, and tolerated when it fails: AI Ark simply has no record of some people,
  // and that must not stop the reply from being drafted and scored.
  if (item.needsEnrich) {
    await appPost("/api/ai/enrich", { leadId: item.conv.lead_id })
      .then(() => { steps += 1; })
      .catch((error) => console.info("reply_radar_ai_enrich_unavailable", { lead: item.conv.lead_id, reason: String(error.message || error).slice(0, 200) }));
  }

  // Analyse first: this single call produces the suggested reply, the review note and the
  // sentiment, and the follow-up score below reads that sentiment.
  if (item.needsReview) {
    const payload = await appPost("/api/ai/draft", {
      ...shared,
      mode: "analyze",
      conversationId: item.conv.id,
      model: String(workspace.anthropic_model || "") || undefined,
      system: String(workspace.custom_system_prompt || "") || undefined,
      instruction: workspace.client_brief ? `Client context: ${workspace.client_brief}` : "",
      campaignName,
      thread,
    });
    const returned = String(payload.sentiment || "").toLowerCase();
    if (["positive", "neutral", "negative"].includes(returned)) sentiment = returned;
    steps += 1;
  }

  if (item.needsIcp) {
    await appPost("/api/ai/icp-score", { ...shared, leadId: item.conv.lead_id, icpPrompt: String(guardrails.icp_prompt || ""), clientBrief: String(workspace.client_brief || "") });
    steps += 1;
  }

  if (item.needsFollowUp) {
    await appPost("/api/ai/follow-up-score", {
      ...shared,
      conversationId: item.conv.id,
      followUpPrompt: String(guardrails.follow_up_prompt || ""),
      sentiment,
      thread,
    });
    steps += 1;
  }

  return steps;
}

async function runAiPipeline() {
  if (!appBaseUrl) {
    // Warned once rather than every cycle, so the log stays readable.
    if (!missingBaseUrlWarned) {
      console.warn("reply_radar_ai_pipeline_skipped", { reason: "APP_BASE_URL is not set, so the worker cannot reach the AI routes" });
      missingBaseUrlWarned = true;
    }
    return;
  }
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + AI_CYCLE_BUDGET_MS;
  const workspaces = (await supabase("rr_workspaces?select=id,slug,name,client_brief,anthropic_model,custom_system_prompt,guardrails&order=created_at.asc")) || [];
  // Start at the client the previous cycle ran out of budget on and wrap around from there, so a
  // large backlog at the top of the list cannot keep the clients below it permanently unprocessed.
  // A cursor naming a client that no longer exists resolves to -1 and falls back to the start.
  const resumeAt = Math.max(0, workspaces.findIndex((workspace) => String(workspace.slug) === aiWorkspaceCursor));
  const ordered = [...workspaces.slice(resumeAt), ...workspaces.slice(0, resumeAt)];

  let processed = 0;
  let steps = 0;
  let errors = 0;
  let lastHeartbeat = Date.now();
  let ranOutOn = "";

  for (const workspace of ordered) {
    if (Date.now() >= deadline) {
      ranOutOn = String(workspace.slug || "");
      break;
    }
    if (Date.now() - lastHeartbeat >= 60_000) {
      lastHeartbeat = Date.now();
      await touchHeartbeat();
    }
    let work = [];
    let leadsById = new Map();
    try {
      ({ work, leadsById } = await conversationsNeedingAi(workspace));
    } catch (error) {
      errors++;
      console.warn("reply_radar_ai_pipeline_scan_error", { workspace: workspace.slug, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!work.length) continue;

    await inParallel(work, AI_CONCURRENCY, async (item) => {
      if (Date.now() >= deadline) {
        ranOutOn = String(workspace.slug || "");
        return;
      }
      try {
        const lead = leadsById.get(String(item.conv.lead_id || ""));
        steps += await runAiForConversation(workspace, item, String((lead && lead.name) || ""));
        processed++;
      } catch (error) {
        errors++;
        console.warn("reply_radar_ai_pipeline_error", { workspace: workspace.slug, conversation: item.conv.id, error: error instanceof Error ? error.message : String(error) });
      }
      if (Date.now() - lastHeartbeat >= 60_000) {
        lastHeartbeat = Date.now();
        await touchHeartbeat();
      }
    });
    console.info("reply_radar_ai_pipeline_workspace", { workspace: workspace.slug, conversations: work.length });
  }
  aiWorkspaceCursor = ranOutOn;
  if (ranOutOn) console.info("reply_radar_ai_pipeline_budget_reached", { resumeAt: ranOutOn, budgetSeconds: AI_CYCLE_BUDGET_MS / 1000 });

  if (processed || errors) {
    await writeSyncRun({ workspace_id: null, run_type: "ai-pipeline", source: "render-worker", status: errors > 0 ? "partial" : "success", started_at: startedAt, finished_at: new Date().toISOString(), records_seen: processed + errors, records_written: steps, error_text: errors > 0 ? `${errors} conversations failed AI processing` : null });
    console.info("reply_radar_ai_pipeline_finished", { processed, steps, ...(errors ? { errors } : {}) });
  }
}

// ── Main loop ───────────────────────────────────────────────────────

async function runOnce() {
  const cycleStarted = new Date().toISOString();
  await writeSyncRun({ workspace_id: null, run_type: "heartbeat", source: "render-worker-heartbeat", status: "running", started_at: cycleStarted, records_seen: 0, records_written: 0 });
  const workspaces = await supabase("rr_workspaces?select=id,slug,heyreach_api_key_ciphertext&order=created_at.asc");
  for (const workspace of workspaces) await syncWorkspace(workspace);
  await writeSyncRun({ workspace_id: null, run_type: "heartbeat", source: "render-worker-heartbeat", status: "success", started_at: cycleStarted, finished_at: new Date().toISOString(), records_seen: workspaces.length, records_written: 0 });

  // Run conversation refresh every ~2.4h (10 batches/day × 5 conversations = 50/workspace/day)
  if (Date.now() - lastRefreshRun >= REFRESH_LOOP_MS) {
    try { await refreshAllConversations(); } catch (error) { console.error("reply_radar_conversation_refresh_failed", error); }
    lastRefreshRun = Date.now();
  }

  // Sweep pre-existing inbound-first (non-campaign) leads out of the database
  // every hour. Ingestion now rejects them up front, so this steadily drains the
  // backlog that was written before the guard shipped.
  if (Date.now() - lastPurgeRun >= PURGE_LOOP_MS) {
    try { await purgeInboundLeads(); } catch (error) { console.error("reply_radar_inbound_purge_failed", error); }
    lastPurgeRun = Date.now();
  }

  // Every cycle, so a reply that arrives while nobody is on the site is already analysed,
  // ICP-scored and follow-up-scored by the time it is opened.
  try { await runAiPipeline(); } catch (error) { console.error("reply_radar_ai_pipeline_failed", error); }
}

async function main() {
  console.info("reply_radar_worker_started", { pollIntervalSeconds: pollIntervalMs / 1000 });
  for (;;) {
    try { await runOnce(); } catch (error) { console.error("reply_radar_worker_cycle_failed", error); }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
