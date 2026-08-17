// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { classifyConversationOrigin } from "../shared/conversation-origin.mjs";
import { directionFor, extractMessageRows, messageKey, syntheticMessageId } from "../shared/message-identity.mjs";
import { ourCampaigns } from "../shared/campaign-code.mjs";
import { sequenceCopy } from "../shared/campaign-sequence.mjs";

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

async function heyReachFetch(apiKey, path, init = {}, timeoutMs = 15_000) {
  const response = await fetch(`${heyreachBase}/${path.replace(/^\//, "")}`, {
    ...init,
    headers: { "X-API-KEY": apiKey, accept: "application/json", "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
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

// ── Reconciliation ──────────────────────────────────────────────────
/**
 * Once a day, per client, asks HeyReach what conversations it has and stores the ones we do not.
 *
 * ── Why this has to exist ────────────────────────────────────────────────────────────────────────
 * Every conversation in Reply Radar arrived through the webhook, and nothing else in the system can
 * discover one. The refresh pass above updates conversations that are already stored; the sync above
 * that only checks the API key still works. So a webhook that is misconfigured, deleted from HeyReach,
 * or that fails while our function is down does not produce an error anywhere — it produces an inbox
 * that is quietly missing replies, which is the one failure nobody notices until a client asks why
 * their prospect was ignored for a fortnight. This pass is the second path in, and it is the reason
 * `rr_workspaces.last_reconciled_at` was in the schema before anything wrote to it.
 *
 * ── Why the cadence is stored in the database, not in a variable ─────────────────────────────────
 * `last_reconciled_at` is the timer. A module-level timestamp would restart at zero on every deploy,
 * and Render restarts the worker on each one — so a busy afternoon of deploys would mean a full
 * fifteen-client reconciliation pass every few minutes. Reading the column means a restart resumes
 * rather than repeats, and one client is done per cycle so the pass never holds the loop for long.
 *
 * ── Why so much is filtered out before HeyReach is asked ─────────────────────────────────────────
 * A HeyReach inbox holds every conversation the sending accounts have ever had, most of which are not
 * ours to store: strangers who messaged the client first are out of scope by rule, and threads with no
 * reply are not what this product is for. Those are skipped here, from the messages HeyReach already
 * embedded in the list response, because a candidate handed to ingestion costs three HeyReach calls
 * and an enrichment attempt to reach the same conclusion — and would be re-examined tomorrow, and the
 * day after, forever, since a discarded conversation leaves no row to recognise it by.
 */
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** HeyReach caps a page at 100 on every endpoint tested. */
const RECONCILE_PAGE_SIZE = 100;
/** 2,000 conversations per client: more than the largest inbox measured, and a stop for a runaway. */
const RECONCILE_MAX_PAGES = 20;
/**
 * How far back a missing conversation is still worth recovering. Long enough to cover a webhook that
 * was broken for a season, short enough that the pass is not re-reading years of inbox every night.
 */
const RECONCILE_LOOKBACK_DAYS = 90;
/**
 * Conversations actually ingested per client per pass. This is the cost ceiling — each one is a
 * HeyReach history fetch, a campaign-membership lookup and an enrichment attempt. A real backlog
 * drains over a few nights rather than arriving as one bill, and the number is an env var because
 * the right value on the first night is not the right value on the hundredth.
 */
const RECONCILE_MAX_INGEST = Math.max(1, Number(process.env.RECONCILE_MAX_INGEST || 25));
/** Wall clock one pass may take before it stops and stamps what it managed. */
const RECONCILE_BUDGET_MS = Math.max(60, Number(process.env.RECONCILE_BUDGET_SECONDS || 420)) * 1000;

/** The HeyReach conversation ids we already hold for a client, including re-keyed duplicates. */
async function storedConversationIds(workspaceId) {
  const known = new Set();
  for (let offset = 0; ; offset += 1000) {
    const rows = await supabase(`rr_conversations?select=heyreach_conversation_id&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=heyreach_conversation_id.asc&offset=${offset}&limit=1000`);
    for (const row of rows || []) {
      const stored = String(row.heyreach_conversation_id || "");
      if (!stored) continue;
      known.add(stored);
      // A lead who replied to two campaigns from two senders is stored a second time under
      // `<id>::<campaign>::<sender>`, so the HeyReach id has to be recovered from the prefix or the
      // conversation looks missing and gets ingested again every night.
      if (stored.includes("::")) known.add(stored.split("::")[0]);
    }
    if (!rows || rows.length < 1000) break;
  }
  return known;
}

/**
 * Conversations a previous pass already offered to ingestion and had turned away, with when.
 *
 * Ingestion is the authority on who belongs in the inbox, and when it declines a conversation it
 * leaves no `rr_conversations` row — so without this the same stranger who cold-messaged the client in
 * March would be fetched, judged and rejected again every single night, at three HeyReach calls a
 * time, forever. The verdict is remembered by the event row reconciliation itself wrote.
 *
 * The timestamp is kept rather than just the id, because the verdict was about the thread as it stood.
 * Somebody we declined can later be added to a campaign and reply, and a conversation with messages
 * newer than the refusal is worth putting to ingestion again.
 */
async function declinedConversations(workspaceId) {
  const declined = new Map();
  const prefix = `${encodeURIComponent("reconcile:")}*`;
  for (let offset = 0; ; offset += 1000) {
    const rows = await supabase(`rr_webhook_events?select=event_key,processed_at&workspace_id=eq.${encodeURIComponent(workspaceId)}&status=eq.discarded&event_key=like.${prefix}&order=event_key.asc&offset=${offset}&limit=1000`);
    for (const row of rows || []) {
      const id = String(row.event_key || "").slice("reconcile:".length);
      if (id) declined.set(id, String(row.processed_at || ""));
    }
    if (!rows || rows.length < 1000) break;
  }
  return declined;
}

/** The conversations HeyReach holds for a client, newest first, bounded by the page ceiling. */
async function heyReachInbox(apiKey) {
  const items = [];
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    // The filters must be nested under `filters`. Passed flat they are silently dropped and the whole
    // inbox comes back at HTTP 200 — see app/lib/heyreach-api.ts. Nothing is filtered here, so the
    // nesting is moot, but the shape is kept so a future filter cannot be added in the wrong place.
    const response = await heyReachFetch(apiKey, "inbox/GetConversationsV2", {
      method: "POST",
      body: JSON.stringify({ offset: page * RECONCILE_PAGE_SIZE, limit: RECONCILE_PAGE_SIZE, filters: {} }),
      // A hundred conversations arrive with their messages inside them, and HeyReach's first call after
      // a quiet period has been measured at 26 seconds. The default 15 would turn its cold start into
      // a failed reconciliation, and then wait a day before finding out whether that was the reason.
    }, 45_000);
    const batch = Array.isArray(response) ? response : (response && Array.isArray(response.items) ? response.items : []);
    items.push(...batch);
    const total = Number((response && response.totalCount) || 0);
    if (batch.length < RECONCILE_PAGE_SIZE || (total && items.length >= total)) break;
  }
  return items;
}

/**
 * Whether a conversation HeyReach knows about is one Reply Radar should hold.
 *
 * Deliberately conservative in one direction only: when the embedded thread is truncated the message
 * order cannot be trusted, so the judgement is deferred to ingestion, which reads the real history.
 * Skipping on incomplete evidence is how a genuine reply would be lost, and that is the whole point.
 */
function reconciliationCandidate(item, cutoffMs) {
  const conversationId = String(item.id || item.conversationId || item.conversation_id || item.linkedInConversationId || "");
  const accountId = String(item.linkedInAccountId || item.linkedInAccount?.id || "");
  const correspondent = (item.correspondentProfile && typeof item.correspondentProfile === "object" ? item.correspondentProfile : {}) || {};
  const profileUrl = String(correspondent.profileUrl || correspondent.profile_url || "");
  // Without a sender account and a profile URL, ingestion cannot read the thread at all.
  if (!conversationId || !accountId || !profileUrl) return null;

  const lastMessageAt = String(item.lastMessageAt || item.last_message_at || "");
  const lastMessageMs = Date.parse(lastMessageAt);
  if (Number.isFinite(lastMessageMs) && lastMessageMs < cutoffMs) return null;

  const rows = extractMessageRows(item);
  const directions = rows.map((row) => directionFor(row, accountId));
  const complete = rows.length >= Math.max(1, Number(item.totalMessages || 0));
  // Nothing to work: this product is about replies, and a thread the lead has not answered is not one.
  // Only trustworthy when the thread is whole — a truncated page could be hiding the reply.
  if (complete && !directions.includes("inbound")) return null;
  // The lead spoke first and HeyReach embedded the whole thread to prove it. Ingestion would reach the
  // same verdict at the cost of three API calls, and would reach it again every night.
  if (complete && directions[0] === "inbound") return null;

  const account = (item.linkedInAccount && typeof item.linkedInAccount === "object" ? item.linkedInAccount : {}) || {};
  return {
    conversationId,
    lastMessageAt,
    payload: {
      event_type: "RECONCILED_CONVERSATION",
      // Read by the webhook route, and the only thing that distinguishes this from a real webhook.
      reply_radar_source: "reconciliation",
      // Stable per conversation, so a conversation that fails to ingest reuses its event row rather
      // than writing a fresh one every night.
      correlation_id: `reconcile:${conversationId}`,
      conversation_id: conversationId,
      timestamp: lastMessageAt || new Date().toISOString(),
      sender: {
        id: accountId,
        full_name: [String(account.firstName || ""), String(account.lastName || "")].filter(Boolean).join(" "),
      },
      lead: {
        id: String(correspondent.linkedin_id || correspondent.linkedinId || ""),
        profile_url: profileUrl,
        first_name: String(correspondent.firstName || ""),
        last_name: String(correspondent.lastName || ""),
        company_name: String(correspondent.companyName || correspondent.company || ""),
        position: String(correspondent.position || correspondent.headline || ""),
      },
      // No campaign is supplied on purpose. Ingestion asks HeyReach which campaigns the lead is
      // actually enrolled in, and that answer is what decides whether we ever contacted them — a
      // campaign name invented here would defeat the guard rather than satisfy it.
    },
  };
}

async function reconcileWorkspace(workspace, deadline) {
  const startedAt = new Date().toISOString();
  const cutoffMs = Date.now() - RECONCILE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  let seen = 0;
  let ingested = 0;
  let discarded = 0;
  let skipped = 0;
  let failed = 0;
  let lastHeartbeat = Date.now();
  let errorText = null;

  try {
    const [known, declined, inbox] = await Promise.all([
      storedConversationIds(workspace.id),
      declinedConversations(workspace.id),
      heyReachInbox(workspace.heyreach_api_key_ciphertext),
    ]);
    seen = inbox.length;
    const missing = [];
    for (const item of inbox) {
      const id = String(item.id || item.conversationId || item.conversation_id || item.linkedInConversationId || "");
      if (!id || known.has(id)) continue;
      const candidate = reconciliationCandidate(item, cutoffMs);
      if (!candidate) continue;
      // Parsed rather than string-compared: HeyReach writes `…T10:00:00.000Z` and Postgres writes
      // `…T10:00:00.123456+00:00`, and those two orderings only agree by luck.
      const refusedAt = Date.parse(declined.get(id) || "");
      const spokeAt = Date.parse(candidate.lastMessageAt || "");
      // Nothing has been said since we were told this one does not belong here.
      if (Number.isFinite(refusedAt) && !(spokeAt > refusedAt)) {
        skipped += 1;
        continue;
      }
      missing.push(candidate);
    }
    // Newest first: a reply from this morning matters more than one from March.
    missing.sort((left, right) => String(right.lastMessageAt).localeCompare(String(left.lastMessageAt)));

    for (const candidate of missing.slice(0, RECONCILE_MAX_INGEST)) {
      if (Date.now() >= deadline) break;
      try {
        const result = await appPost(`/api/webhooks/heyreach/${encodeURIComponent(workspace.slug)}`, candidate.payload);
        if (result && result.discarded) discarded += 1;
        else ingested += 1;
      } catch (error) {
        failed += 1;
        console.warn("reply_radar_reconcile_ingest_failed", { workspace: workspace.slug, conversation: candidate.conversationId, error: error instanceof Error ? error.message : String(error) });
      }
      // The health page calls the worker stale after five minutes, so a long pass says it is alive.
      if (Date.now() - lastHeartbeat >= 60_000) {
        lastHeartbeat = Date.now();
        await touchHeartbeat();
      }
      // HeyReach is doing three calls behind each of these; give it room.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    console.info("reply_radar_reconciled", { workspace: workspace.slug, heyreachConversations: seen, missing: missing.length, ingested, discarded, ...(skipped ? { previouslyDeclined: skipped } : {}), ...(failed ? { failed } : {}) });
  } catch (error) {
    errorText = error instanceof Error ? error.message : "Reconciliation failed";
    console.warn("reply_radar_reconcile_failed", { workspace: workspace.slug, error: errorText });
  }

  /*
   * Stamped even when the pass was partial or failed outright.
   *
   * This column is the schedule as well as the record. Leaving it unstamped after a client that ran
   * out of budget would put that same client at the front of the queue on the next cycle and every
   * cycle after it, and the fourteen clients behind it would never be reconciled at all. A backlog
   * drains at `RECONCILE_MAX_INGEST` a night instead, which is slower and fair.
   */
  await supabase(`rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ last_reconciled_at: new Date().toISOString() }),
  }).catch((error) => console.warn("reply_radar_reconcile_stamp_failed", { workspace: workspace.slug, error: error instanceof Error ? error.message : String(error) }));

  await writeSyncRun({
    workspace_id: workspace.id,
    run_type: "reconciliation",
    source: "render-worker",
    status: errorText ? "failed" : failed > 0 ? "partial" : "success",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    records_seen: seen,
    records_written: ingested,
    error_text: errorText || (failed > 0 ? `${failed} conversations failed to ingest` : null),
  });
}

async function reconcileDueWorkspace() {
  if (!appBaseUrl) return;
  const due = new Date(Date.now() - RECONCILE_INTERVAL_MS).toISOString();
  // One client per cycle. Fifteen clients at a cycle every two minutes means the whole roster is
  // covered within half an hour of falling due, without any single cycle carrying all of it.
  const workspaces = await supabase(`rr_workspaces?select=id,slug,heyreach_api_key_ciphertext&heyreach_api_key_ciphertext=not.is.null&or=(last_reconciled_at.is.null,last_reconciled_at.lt.${encodeURIComponent(due)})&order=last_reconciled_at.asc.nullsfirst&limit=1`);
  const workspace = (workspaces || [])[0];
  if (!workspace || !workspace.slug) return;
  await reconcileWorkspace(workspace, Date.now() + RECONCILE_BUDGET_MS);
}

// ── Log retention ───────────────────────────────────────────────────
/**
 * Deletes the worker's own log after 48 hours.
 *
 * `rr_sync_runs` is written seventeen times a cycle — two heartbeats and one row per client — which is
 * about twelve thousand rows a day and, left alone, four and a half million a year for a table whose
 * every reader asks for the newest twenty-five. The database had reached ninety thousand rows before
 * this existed. `supabase/schema.sql` has always carried an `rr_prune_sync_runs()` function for this
 * and the pg_cron line to schedule it was only ever a comment, so it never ran; doing it from the
 * worker needs nothing enabled in Supabase and cannot silently stop being scheduled.
 *
 * AI Ark rows are the one exception. They are one per lead enrichment rather than per cycle, so they
 * are not the volume problem, and the health page draws a fourteen-day enrichment usage chart from
 * them — a 48-hour sweep would leave that chart with two bars and no way to tell that it used to have
 * fourteen.
 */
const RETENTION_LOOP_MS = 60 * 60 * 1000;
const RETENTION_HOURS = Math.max(2, Number(process.env.SYNC_RUN_RETENTION_HOURS || 48));
const AI_ARK_RETENTION_DAYS = 14;
let lastRetentionRun = 0;

async function pruneSyncRuns() {
  const workerCutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  const aiArkCutoff = new Date(Date.now() - AI_ARK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // `count=exact` so the log says how much was removed; the rows themselves are not returned.
  const deleteRows = async (query) => {
    const response = await fetch(`${supabaseUrl}/rest/v1/rr_sync_runs?${query}`, {
      method: "DELETE",
      headers: { ...headers, Prefer: "return=minimal,count=exact" },
    });
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 300)}`);
    // PostgREST reports the affected count in the Content-Range header as `*/N`.
    return Number(String(response.headers.get("content-range") || "").split("/")[1] || 0);
  };

  // `source.is.null` is spelled out because a null never satisfies `neq` in PostgREST, and rows from
  // the original schema have no source — those are exactly the oldest rows in the table.
  const worker = await deleteRows(`or=(source.is.null,source.neq.ai_ark)&started_at=lt.${encodeURIComponent(workerCutoff)}`);
  const aiArk = await deleteRows(`source=eq.ai_ark&started_at=lt.${encodeURIComponent(aiArkCutoff)}`);
  if (worker || aiArk) console.info("reply_radar_sync_runs_pruned", { worker, aiArk, retentionHours: RETENTION_HOURS });
}

// ── Analytics collection ────────────────────────────────────────────
/**
 * Fills `rr_campaign_stats` and `rr_daily_stats` so the analytics pages never talk to HeyReach.
 *
 * ── Why this moved here ──────────────────────────────────────────────────────────────────────────
 * `/api/analytics` asks HeyReach for a campaign list and a stats rollup for every client before it can
 * answer, and a per-client page needs a call per sender on top of that. None of it can be cached for
 * long and all of it is on the critical path of a page load, so the analytics tab opened as an empty
 * shell and filled in two or three seconds later. Collected here instead, the page is one Supabase
 * read: the numbers are a day old at worst, the page says exactly when they were taken, and there is a
 * button to take them again — which is a better trade than a blank screen on every visit.
 *
 * ── One client per cycle ─────────────────────────────────────────────────────────────────────────
 * A pass is roughly sixteen HeyReach calls, so doing every client in one cycle would be a couple of
 * hundred and would stretch a cycle past the point where the health page calls the worker stale. The
 * client whose stored figures are oldest is picked instead, one per cycle, and needs no state of its
 * own: `refreshed_at` in the table is the timer, so a deploy resumes the rotation rather than
 * restarting it.
 *
 * ── Once a day, or when somebody asks ────────────────────────────────────────────────────────────
 * A day is the cadence because these figures move on the scale of a day's sending — a campaign's
 * lifetime acceptance rate does not meaningfully change between breakfast and lunch — and because
 * HeyReach's rate limit is a shared budget with the inbox sync, which is the part that has to be
 * timely. Anyone who wants figures sooner than that presses the button on the client's page, which
 * queues an `rr_sync_runs` row that `queuedAnalyticsRequest` claims ahead of the rotation.
 */
const ANALYTICS_STALENESS_MS = 24 * 60 * 60 * 1000;
/**
 * Days of daily history rewritten each pass.
 *
 * The charts show a fortnight. Three weeks is written so that the fortnight is still complete after a
 * week in which the worker was down, and because HeyReach can revise a recent day — an acceptance
 * lands against the day the request went out, not the day it was accepted.
 */
const ANALYTICS_WINDOW_DAYS = 21;
const ANALYTICS_PAGE_SIZE = 100;
/** 2,000 campaigns per client: far past the largest account seen, and a stop for a bad `totalCount`. */
const ANALYTICS_MAX_PAGES = 20;
/**
 * Sequences read per pass. The copy inside a campaign never changes once it is running, so this is a
 * backfill rather than a refresh: a client with sixty campaigns is complete after ten passes and then
 * costs nothing, instead of sixty calls every half hour forever.
 */
const ANALYTICS_SEQUENCE_BUDGET = 6;

/** Every campaign on the account, ours and the client's own, so the filter can be applied once. */
async function heyReachCampaignPages(apiKey) {
  const items = [];
  for (let page = 0; page < ANALYTICS_MAX_PAGES; page += 1) {
    const response = await heyReachFetch(apiKey, "campaign/GetAll", {
      method: "POST",
      body: JSON.stringify({ offset: page * ANALYTICS_PAGE_SIZE, limit: ANALYTICS_PAGE_SIZE }),
    });
    const batch = Array.isArray(response?.items) ? response.items : [];
    items.push(...batch);
    const total = Number(response?.totalCount || 0);
    if (batch.length < ANALYTICS_PAGE_SIZE || (total && items.length >= total)) break;
  }
  return items;
}

/** `rr_campaign_stats` for one client: the campaign list joined to the lifetime rollup. */
async function collectCampaignStats(workspace) {
  const apiKey = workspace.heyreach_api_key_ciphertext;
  const [campaigns, rollup, stored] = await Promise.all([
    heyReachCampaignPages(apiKey),
    heyReachFetch(apiKey, "stats/GetOverallStatsByCampaign", {
      method: "POST",
      // Pinned to 2020 for the same reason the API route pins it: these are lifetime totals, and a
      // rollup with no date range comes back empty rather than all-time.
      body: JSON.stringify({ accountIds: [], campaignIds: [], startDate: "2020-01-01T00:00:00.000Z", endDate: new Date().toISOString() }),
    }).catch(() => null),
    supabase(`rr_campaign_stats?select=campaign_id,first_touch,follow_up,sequence_steps,sequence_fetched_at&workspace_id=eq.${encodeURIComponent(workspace.id)}&limit=2000`),
  ]);
  // A client's own pre-engagement campaigns share this API key. Dropped at the edge, as everywhere
  // else, so nothing downstream can count them as our work.
  const ours = ourCampaigns(campaigns, (row) => row.name);
  if (!ours.length) return 0;

  const statsById = new Map();
  for (const row of Array.isArray(rollup?.overallStats) ? rollup.overallStats : []) {
    statsById.set(String(row.campaignId ?? ""), row);
  }
  const storedById = new Map((stored || []).map((row) => [String(row.campaign_id), row]));

  /*
   * Which campaigns get their copy read this pass.
   *
   * Newest first, because a campaign launched this week is the one somebody is asking about. Campaigns
   * whose copy is already stored are skipped entirely — that is what makes this a backfill that finishes
   * rather than a cost that recurs.
   */
  const needsCopy = ours
    .filter((row) => !storedById.get(String(row.id))?.sequence_fetched_at)
    .sort((left, right) => String(right.startedAt || right.creationTime || "").localeCompare(String(left.startedAt || left.creationTime || "")))
    .slice(0, ANALYTICS_SEQUENCE_BUDGET);
  const copyById = new Map();
  for (const campaign of needsCopy) {
    try {
      // A query parameter, not a path segment — see the same call in app/lib/heyreach-api.ts.
      const sequence = await heyReachFetch(apiKey, `campaign/GetCampaignSequence?campaignId=${encodeURIComponent(String(campaign.id))}`, { method: "GET" });
      copyById.set(String(campaign.id), sequenceCopy(sequence));
    } catch (error) {
      console.warn("reply_radar_analytics_sequence_failed", { workspace: workspace.slug, campaign: String(campaign.id), error: error instanceof Error ? error.message : String(error) });
    }
  }

  const now = new Date().toISOString();
  const rows = ours.map((campaign) => {
    const id = String(campaign.id);
    const stats = statsById.get(id) || {};
    const progress = campaign.progressStats && typeof campaign.progressStats === "object" ? campaign.progressStats : {};
    const previous = storedById.get(id) || {};
    const fetched = copyById.get(id);
    return {
      workspace_id: workspace.id,
      campaign_id: id,
      name: String(campaign.name || ""),
      status: String(campaign.status || "") || null,
      launched_at: String(campaign.startedAt || campaign.creationTime || "") || null,
      sender_ids: (Array.isArray(campaign.campaignAccountIds) ? campaign.campaignAccountIds : []).map((value) => String(value)),
      total_leads: Number(progress.totalUsers || 0),
      leads_pending: Number(progress.totalUsersPending || 0),
      leads_in_progress: Number(progress.totalUsersInProgress || 0),
      leads_finished: Number(progress.totalUsersFinished || 0),
      connections_sent: Number(stats.connectionsSent || 0),
      connections_accepted: Number(stats.connectionsAccepted || 0),
      replies: Number(stats.totalMessageReplies || 0) + Number(stats.totalInmailReplies || 0),
      messages_started: Number(stats.totalMessageStarted || 0) + Number(stats.totalInmailStarted || 0),
      // Carried forward rather than omitted. An upsert has to send the same keys for every row, so a
      // row without these would write nulls over copy a previous pass had already read.
      first_touch: fetched ? fetched.firstTouch || null : previous.first_touch ?? null,
      follow_up: fetched ? fetched.followUp || null : previous.follow_up ?? null,
      sequence_steps: fetched ? fetched.steps : previous.sequence_steps ?? null,
      sequence_fetched_at: fetched ? now : previous.sequence_fetched_at ?? null,
      refreshed_at: now,
    };
  });

  await supabase("rr_campaign_stats?on_conflict=workspace_id,campaign_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  /*
   * Campaigns HeyReach no longer lists are deleted rather than left behind.
   *
   * A campaign can be removed on their side, and a stale row would keep counting toward "campaigns
   * launched" and could win a "best performing" ranking with figures nobody can check. Scoped to this
   * client and to ids we did not just write.
   */
  const keep = rows.map((row) => `"${row.campaign_id}"`).join(",");
  await supabase(`rr_campaign_stats?workspace_id=eq.${encodeURIComponent(workspace.id)}&campaign_id=not.in.(${keep})`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  }).catch((error) => console.warn("reply_radar_analytics_prune_failed", { workspace: workspace.slug, error: error instanceof Error ? error.message : String(error) }));
  return rows.length;
}

/**
 * `rr_daily_stats` for one client: a day-by-day series for the client as a whole, and one per sender.
 *
 * Both are asked for, rather than deriving the total by adding the senders up. They do agree today —
 * checked against HeyReach's dashboard on three consecutive days, where four campaign-assigned senders
 * summed to 100 against a client total of 108 until the two accounts HeyReach reports as `isActive:
 * false` were included as well, at which point it matched exactly. `isActive` turns out to mean "on a
 * running campaign", not "has ever sent". They would stop agreeing the moment a LinkedIn account is
 * disconnected, though: it drops out of the account list and would take its history out of the sum with
 * it, quietly lowering every past day. The total is the number somebody would check against HeyReach,
 * so it is stored as HeyReach reports it.
 */
async function collectDailyStats(workspace) {
  const apiKey = workspace.heyreach_api_key_ciphertext;
  const start = new Date(Date.now() - (ANALYTICS_WINDOW_DAYS - 1) * 86_400_000);
  const startDate = `${start.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const endDate = new Date().toISOString();
  const series = (accountIds) => heyReachFetch(apiKey, "stats/GetOverallStats", {
    method: "POST",
    body: JSON.stringify({ accountIds, campaignIds: [], startDate, endDate }),
  });

  const accountsResponse = await heyReachFetch(apiKey, "linkedinAccount/GetAll", {
    method: "POST",
    body: JSON.stringify({ offset: 0, limit: ANALYTICS_PAGE_SIZE }),
  }).catch(() => null);
  const accounts = Array.isArray(accountsResponse?.items) ? accountsResponse.items : [];

  const rows = [];
  const now = new Date().toISOString();
  const push = (senderId, senderName, dailyLimit, response) => {
    const byDay = response?.byDayStats && typeof response.byDayStats === "object" ? response.byDayStats : {};
    for (const [stamp, day] of Object.entries(byDay)) {
      if (!day || typeof day !== "object") continue;
      rows.push({
        workspace_id: workspace.id,
        day: String(stamp).slice(0, 10),
        sender_id: senderId,
        sender_name: senderName,
        connections_sent: Number(day.connectionsSent || 0),
        connections_accepted: Number(day.connectionsAccepted || 0),
        messages_sent: Number(day.messagesSent || 0) + Number(day.inmailMessagesSent || 0),
        replies: Number(day.totalMessageReplies || 0) + Number(day.totalInmailReplies || 0),
        daily_limit: dailyLimit,
        refreshed_at: now,
      });
    }
  };

  // The all-senders total. `sender_id = ''` is what marks it, and the primary key keeps it from
  // colliding with any real sender.
  push("", "", null, await series([]).catch(() => null));
  for (const account of accounts) {
    const id = String(account.id ?? "");
    if (!id) continue;
    const limits = account.accountLimits && typeof account.accountLimits === "object" ? account.accountLimits : {};
    // `connectioRequestLimit` is spelled that way by the API. Both spellings are read so a fix on
    // their side does not turn the cap into a null.
    const cap = Number(limits.connectioRequestLimit ?? limits.connectionRequestLimit ?? 0) || null;
    const name = [String(account.firstName || ""), String(account.lastName || "")].filter(Boolean).join(" ") || `Sender ${id}`;
    push(id, name, cap, await series([Number(id) || id]).catch(() => null));
  }
  if (!rows.length) return 0;
  await supabase("rr_daily_stats?on_conflict=workspace_id,day,sender_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  return rows.length;
}

/** The client whose stored analytics are oldest, or one that has none at all. */
async function staleAnalyticsWorkspace() {
  const workspaces = await supabase("rr_workspaces?select=id,slug,heyreach_api_key_ciphertext&heyreach_api_key_ciphertext=not.is.null&order=created_at.asc");
  if (!workspaces || !workspaces.length) return null;
  // Grouping has to happen here: PostgREST has no `max(...) group by`, and two columns over a thousand
  // campaign rows is a smaller read than the aggregate would save.
  const freshest = new Map();
  const stamps = await supabase("rr_campaign_stats?select=workspace_id,refreshed_at&order=refreshed_at.desc&limit=5000");
  for (const row of stamps || []) {
    const id = String(row.workspace_id);
    // Descending, so the first stamp seen for a workspace is its newest.
    if (!freshest.has(id)) freshest.set(id, Date.parse(String(row.refreshed_at || "")) || 0);
  }
  const ranked = workspaces
    .map((workspace) => ({ workspace, at: freshest.get(String(workspace.id)) ?? 0 }))
    .sort((left, right) => left.at - right.at);
  const oldest = ranked[0];
  // Nothing is due. With two clients on the roster this is what stops the pass running every cycle.
  if (!oldest || Date.now() - oldest.at < ANALYTICS_STALENESS_MS) return null;
  return oldest.workspace;
}

/** PATCHes one `rr_sync_runs` row. Used to move a requested refresh through its states. */
function patchSyncRun(id, patch) {
  return supabase(`rr_sync_runs?id=eq.${encodeURIComponent(String(id))}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}

/**
 * A refresh somebody pressed the button for, claimed so it is never worked twice.
 *
 * `/api/analytics/client/refresh` writes a `queued` analytics run rather than collecting anything
 * itself: a pass is a couple of hundred HeyReach calls against a rate limit this process already owns,
 * and a serverless function has ten seconds. There is no channel from the app to this worker, so the
 * table is the channel.
 *
 * The row is flipped to `running` before a single HeyReach call is made, which is what stops a pass
 * that throws from being retried on every cycle for the next two days.
 */
async function queuedAnalyticsRequest() {
  const queued = await supabase("rr_sync_runs?select=id,workspace_id&run_type=eq.analytics&status=eq.queued&workspace_id=not.is.null&order=started_at.asc&limit=1");
  const request = queued?.[0];
  if (!request) return null;
  const workspaces = await supabase(`rr_workspaces?select=id,slug,heyreach_api_key_ciphertext&id=eq.${encodeURIComponent(String(request.workspace_id))}&limit=1`);
  const workspace = workspaces?.[0];
  if (!workspace?.heyreach_api_key_ciphertext) {
    // Closed rather than left queued: a client with no key will never be collectable, and a request
    // that stays `queued` leaves the page showing a progress bar that can never finish.
    await patchSyncRun(request.id, { status: "failed", finished_at: new Date().toISOString(), error_text: "No HeyReach key on this client" });
    return null;
  }
  await patchSyncRun(request.id, { status: "running" });
  return { workspace, requestId: String(request.id) };
}

async function collectAnalytics() {
  // Asked-for refreshes go ahead of the daily rotation — somebody is watching a progress bar.
  const request = await queuedAnalyticsRequest();
  const workspace = request?.workspace ?? (await staleAnalyticsWorkspace());
  if (!workspace) return;
  const startedAt = new Date().toISOString();
  let campaigns = 0;
  let days = 0;
  let errorText = null;
  try {
    campaigns = await collectCampaignStats(workspace);
    await touchHeartbeat();
    days = await collectDailyStats(workspace);
    console.info("reply_radar_analytics_collected", { workspace: workspace.slug, campaigns, dailyRows: days, requested: Boolean(request) });
  } catch (error) {
    errorText = error instanceof Error ? error.message : "Analytics collection failed";
    console.warn("reply_radar_analytics_failed", { workspace: workspace.slug, error: errorText });
  }
  const finished = {
    status: errorText ? "failed" : "success",
    finished_at: new Date().toISOString(),
    records_seen: campaigns,
    records_written: campaigns + days,
    error_text: errorText,
  };
  // A requested pass finishes the row it was asked through instead of writing a second one beside it,
  // so the log stays one row per pass and the page watches that row go queued → running → success.
  if (request) await patchSyncRun(request.requestId, finished);
  else await writeSyncRun({ workspace_id: workspace.id, run_type: "analytics", source: "render-worker", started_at: startedAt, ...finished });
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

  // Trim the worker's own log every hour, so the table stays at about two days of rows instead of
  // growing by twelve thousand a day forever.
  if (Date.now() - lastRetentionRun >= RETENTION_LOOP_MS) {
    try { await pruneSyncRuns(); } catch (error) { console.error("reply_radar_sync_run_prune_failed", error); }
    lastRetentionRun = Date.now();
  }

  /*
   * One client per cycle, and only if its last reconciliation was over a day ago.
   *
   * Placed before the AI pipeline so a conversation recovered here is analysed on the same cycle it
   * was found rather than waiting for the next one — the pipeline's own budget is what stops the two
   * of them together from stretching a cycle indefinitely.
   */
  try { await reconcileDueWorkspace(); } catch (error) { console.error("reply_radar_reconcile_cycle_failed", error); }

  /*
   * One client's analytics per cycle: whoever asked for a refresh first, else the client whose stored
   * figures are oldest, and only once they are over a day old.
   *
   * No loop timer here on purpose: the staleness check is inside `staleAnalyticsWorkspace`, reading
   * `refreshed_at` out of the table rather than a variable that a deploy would reset. Fifteen clients
   * all falling due at once are then worked off one per cycle over the following half hour, which is
   * the cadence rather than a queue.
   */
  try { await collectAnalytics(); } catch (error) { console.error("reply_radar_analytics_cycle_failed", error); }

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
