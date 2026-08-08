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
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function checkHeyReach(apiKey) {
  const response = await fetch(`${heyreachBase}/auth/CheckApiKey`, { headers: { "X-API-KEY": apiKey, accept: "application/json" } });
  if (!response.ok) throw new Error(`HeyReach ${response.status}`);
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
  await supabase("rr_sync_runs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ workspace_id: workspace.id, source: "render-worker", status, started_at: startedAt, finished_at: new Date().toISOString(), records_seen: recordsSeen, records_written: 0, error_text: errorText }) });
  console.info("reply_radar_workspace_sync", { workspace: workspace.slug, status, error: errorText });
}

async function runOnce() {
  const cycleStarted = new Date().toISOString();
  await supabase("rr_sync_runs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ workspace_id: null, source: "render-worker-heartbeat", status: "running", started_at: cycleStarted, records_seen: 0, records_written: 0 }) });
  const workspaces = await supabase("rr_workspaces?select=id,slug,heyreach_api_key_ciphertext&order=created_at.asc");
  for (const workspace of workspaces) await syncWorkspace(workspace);
  await supabase("rr_sync_runs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ workspace_id: null, source: "render-worker-heartbeat", status: "success", started_at: cycleStarted, finished_at: new Date().toISOString(), records_seen: workspaces.length, records_written: 0 }) });
}

async function main() {
  console.info("reply_radar_worker_started", { pollIntervalSeconds: pollIntervalMs / 1000 });
  for (;;) {
    try { await runOnce(); } catch (error) { console.error("reply_radar_worker_cycle_failed", error); }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
