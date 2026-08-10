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
  console.info("reply_radar_workspace_sync", { workspace: workspace.slug, status, error: errorText });
}

// ── Conversation refresh ────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_BATCH_SIZE = 20;
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

function messageArrays(root) {
  const candidates = [];
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || depth > 6 || seen.has(value)) return;
    if (typeof value === "object") seen.add(value);
    if (Array.isArray(value)) {
      const rows = value.filter((v) => v && typeof v === "object" && !Array.isArray(v));
      if (rows.some((r) => r.message !== undefined || r.body !== undefined || r.text !== undefined || r.content !== undefined || r.message_type !== undefined)) candidates.push(rows);
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    if (typeof value === "object") Object.values(value).forEach((v) => visit(v, depth + 1));
  };
  visit(root, 0);
  return candidates.sort((a, b) => b.length - a.length)[0] || [];
}

function directionFor(row, accountId) {
  if (typeof row.is_reply === "boolean") return row.is_reply ? "inbound" : "outbound";
  if (typeof row.isReply === "boolean") return row.isReply ? "inbound" : "outbound";
  for (const key of ["isFromMe", "fromMe", "sentByMe"]) if (typeof row[key] === "boolean") return row[key] ? "outbound" : "inbound";
  const dir = String(row.direction || row.messageDirection || "").toLowerCase();
  if (["outbound", "sent", "sender"].some((p) => dir.includes(p))) return "outbound";
  if (["inbound", "received", "reply"].some((p) => dir.includes(p))) return "inbound";
  const sid = String(row.senderId || row.sender_id || row.linkedInAccountId || row.accountId || "");
  return sid && sid === accountId ? "outbound" : "inbound";
}

async function refreshConversation(workspace, conv) {
  const apiKey = workspace.heyreach_api_key_ciphertext;
  const accountId = String(conv.account_id || "");
  const heyreachConvId = String(conv.heyreach_conversation_id || "");
  if (!accountId || !heyreachConvId) return 0;

  // Get lead profile URL
  const leads = conv.lead_id ? await supabase(`rr_leads?select=linkedin_profile_url&id=eq.${encodeURIComponent(conv.lead_id)}&limit=1`) : [];
  const profileUrl = String((leads && leads[0]?.linkedin_profile_url) || "");

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

  const rawMessages = messageArrays(chatroom);
  const now = new Date().toISOString();
  const messages = rawMessages.map((row) => {
    const direction = directionFor(row, accountId);
    const sentAtRaw = row.creation_time || row.creationTime || row.createdAt || row.sentAt || row.timestamp;
    const parsed = new Date(String(sentAtRaw || ""));
    const sentAt = Number.isNaN(parsed.getTime()) ? now : parsed.toISOString();
    const body = String(row.message || row.body || row.text || row.content || row.messageText || row.messageBody || "[Empty message]").trim();
    const externalId = String(row.id || row.messageId || row.message_id || row.linkedinMessageId || `rr-refresh-${direction}-${sentAt}-${body.slice(0, 30)}`);
    return { externalId, direction, body, sentAt };
  });

  // Get existing messages for fingerprint matching
  const existing = await supabase(`rr_messages?select=heyreach_message_id,direction,body,sent_at&conversation_id=eq.${encodeURIComponent(conv.id)}`);
  const fpMap = new Map((existing || []).map((m) => [`${m.direction}|${new Date(String(m.sent_at)).toISOString()}|${m.body}`, m.heyreach_message_id]));

  const records = messages.map((m) => {
    const fp = `${m.direction}|${new Date(m.sentAt).toISOString()}|${m.body}`;
    return {
      conversation_id: conv.id,
      heyreach_message_id: fpMap.get(fp) || m.externalId,
      direction: m.direction,
      body: m.body,
      sent_at: m.sentAt,
      raw_data: { reply_radar: { source: "refresh", refreshed_at: now } },
    };
  });

  if (records.length) {
    for (let i = 0; i < records.length; i += 200) {
      await supabase("rr_messages?on_conflict=conversation_id,heyreach_message_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(records.slice(i, i + 200)),
      });
    }
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
    const cutoff = new Date(Date.now() - REFRESH_INTERVAL_MS).toISOString();
    const conversations = await supabase(
      `rr_conversations?select=id,lead_id,account_id,heyreach_conversation_id&workspace_id=eq.${encodeURIComponent(workspace.id)}&or=(last_refreshed_at.is.null,last_refreshed_at.lt.${encodeURIComponent(cutoff)})&order=last_refreshed_at.asc.nullsfirst&limit=${REFRESH_BATCH_SIZE}`,
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

// ── Main loop ───────────────────────────────────────────────────────

async function runOnce() {
  const cycleStarted = new Date().toISOString();
  await writeSyncRun({ workspace_id: null, run_type: "heartbeat", source: "render-worker-heartbeat", status: "running", started_at: cycleStarted, records_seen: 0, records_written: 0 });
  const workspaces = await supabase("rr_workspaces?select=id,slug,heyreach_api_key_ciphertext&order=created_at.asc");
  for (const workspace of workspaces) await syncWorkspace(workspace);
  await writeSyncRun({ workspace_id: null, run_type: "heartbeat", source: "render-worker-heartbeat", status: "success", started_at: cycleStarted, finished_at: new Date().toISOString(), records_seen: workspaces.length, records_written: 0 });

  // Run conversation refresh every 24 hours
  if (Date.now() - lastRefreshRun >= REFRESH_INTERVAL_MS) {
    try { await refreshAllConversations(); } catch (error) { console.error("reply_radar_conversation_refresh_failed", error); }
    lastRefreshRun = Date.now();
  }
}

async function main() {
  console.info("reply_radar_worker_started", { pollIntervalSeconds: pollIntervalMs / 1000 });
  for (;;) {
    try { await runOnce(); } catch (error) { console.error("reply_radar_worker_cycle_failed", error); }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
