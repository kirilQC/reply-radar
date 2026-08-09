import { NextResponse } from "next/server";

type Row = Record<string, unknown>;
const ageSeconds = (value: unknown) => value ? Math.max(0, Math.floor((Date.now() - new Date(String(value)).getTime()) / 1000)) : null;
const safeJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text.trim()) return [];
  try { return JSON.parse(text); } catch { return { parseError: true, responseText: text.slice(0, 2_000) }; }
};

export async function GET() {
  const checkedAt = new Date().toISOString();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const thresholds = { workerFreshSeconds: 300, webhookFreshSeconds: 1800, pollFreshSeconds: 3600 };
  const services = [
    { id: "supabase", label: "Supabase database", configured: Boolean(url && key), explanation: "Stores clients, messages, and every heartbeat record." },
    { id: "anthropic", label: "Anthropic API", configured: Boolean(process.env.ANTHROPIC_API_KEY), explanation: "Creates AI reply drafts when a teammate asks for one." },
    { id: "worker", label: "Render worker", configured: false, explanation: "Wakes up in the background and checks every client connection." },
  ];
  if (!url || !key) return NextResponse.json({ status: "not_configured", services, clients: [], checkedAt, thresholds, diagnostics: { runtime: { node: process.version, supabaseUrlConfigured: Boolean(url), serviceRoleKeyConfigured: Boolean(key), anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY), workerServiceUrlConfigured: Boolean(process.env.WORKER_SERVICE_URL) } } });

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const request = async (path: string) => {
    const started = Date.now();
    const response = await fetch(`${url}/rest/v1/${path}`, { headers, cache: "no-store" });
    return { response, body: await safeJson(response), durationMs: Date.now() - started };
  };

  try {
    const [workspaceResult, syncResult, eventResult, schemaResult] = await Promise.all([
      request("rr_workspaces?select=*&order=name.asc"),
      request("rr_sync_runs?select=*&order=started_at.desc&limit=25"),
      request("rr_webhook_events?select=*&order=received_at.desc&limit=25"),
      request(""),
    ]);
    if (!workspaceResult.response.ok) throw new Error(`Workspace query failed (${workspaceResult.response.status})`);
    const rows = Array.isArray(workspaceResult.body) ? workspaceResult.body as Row[] : [];
    const syncRuns = Array.isArray(syncResult.body) ? syncResult.body as Row[] : [];
    const webhookEvents = Array.isArray(eventResult.body) ? eventResult.body as Row[] : [];
    const workerRun = syncRuns.find((run) => run.source === "render-worker-heartbeat" || run.run_type === "heartbeat");
    const workerAgeSeconds = ageSeconds(workerRun?.started_at);
    services[2].configured = workerAgeSeconds !== null && workerAgeSeconds <= thresholds.workerFreshSeconds;

    const clients = rows.map((row) => {
      const webhookAgeSeconds = ageSeconds(row.last_webhook_received_at);
      const pollAgeSeconds = ageSeconds(row.last_successful_poll_at);
      const keyConfigured = Boolean(row.heyreach_api_key_ciphertext);
      const webhookHealthy = webhookAgeSeconds !== null && webhookAgeSeconds <= thresholds.webhookFreshSeconds;
      const pollHealthy = pollAgeSeconds !== null && pollAgeSeconds <= thresholds.pollFreshSeconds;
      const recentRuns = syncRuns.filter((run) => run.workspace_id === row.id).slice(0, 10);
      const recentEvents = webhookEvents.filter((event) => event.workspace_id === row.id).slice(0, 10);
      return {
        id: row.id, name: row.name, slug: row.slug, logoUrl: row.logo_url ?? null, websiteUrl: row.website_url ?? null, keyConfigured, webhookAgeSeconds, pollAgeSeconds,
        lastWebhookReceivedAt: row.last_webhook_received_at ?? null, lastSuccessfulPollAt: row.last_successful_poll_at ?? null, lastReconciledAt: row.last_reconciled_at ?? null,
        webhookStatus: !keyConfigured ? "Add a HeyReach API key first." : webhookHealthy ? "Replies are reaching Reply Radar." : webhookAgeSeconds === null ? "No webhook has arrived yet." : "No webhook has arrived recently.",
        pollStatus: pollHealthy ? "The background check ran recently." : pollAgeSeconds === null ? "The background check has never finished." : "The background check is late.",
        status: keyConfigured && webhookHealthy && pollHealthy ? "healthy" : keyConfigured ? "attention" : "missing",
        recentRuns, recentEvents,
        raw: { ...row, heyreach_api_key_ciphertext: keyConfigured ? "[configured — hidden]" : null, webhook_secret_hash: row.webhook_secret_hash ? "[configured — hidden]" : null },
      };
    });
    const worker = workerRun ? {
      status: workerAgeSeconds !== null && workerAgeSeconds <= thresholds.workerFreshSeconds ? "running" : "stale", recordedStatus: workerRun.status,
      ageSeconds: workerAgeSeconds, startedAt: workerRun.started_at ?? null, finishedAt: workerRun.finished_at ?? null,
      durationSeconds: workerRun.finished_at && workerRun.started_at ? Math.max(0, (new Date(String(workerRun.finished_at)).getTime() - new Date(String(workerRun.started_at)).getTime()) / 1000) : null,
      workspacesSeen: workerRun.records_seen ?? 0, recordsWritten: workerRun.records_written ?? 0, source: workerRun.source ?? null, runType: workerRun.run_type ?? null,
      error: workerRun.error_text ?? null, recentRuns: syncRuns.slice(0, 15), raw: workerRun,
    } : null;
    const definitions = schemaResult.body && typeof schemaResult.body === "object" && "definitions" in schemaResult.body ? (schemaResult.body as { definitions?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> }).definitions ?? {} : {};
    const schemaTables = ["rr_workspaces", "rr_leads", "rr_conversations", "rr_messages", "rr_webhook_events", "rr_sync_runs"].reduce<Record<string, unknown>>((result, table) => {
      result[table] = { columns: Object.keys(definitions[table]?.properties ?? {}), required: definitions[table]?.required ?? [] };
      return result;
    }, {});
    return NextResponse.json({ status: "live", services, clients, worker, checkedAt, thresholds, diagnostics: {
      runtime: { node: process.version, supabaseUrlConfigured: true, serviceRoleKeyConfigured: true, anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY), workerServiceUrlConfigured: Boolean(process.env.WORKER_SERVICE_URL), pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS || 120) },
      queries: {
        workspaces: { status: workspaceResult.response.status, ok: workspaceResult.response.ok, durationMs: workspaceResult.durationMs, rowCount: rows.length },
        syncRuns: { status: syncResult.response.status, ok: syncResult.response.ok, durationMs: syncResult.durationMs, rowCount: syncRuns.length, error: syncResult.response.ok ? null : syncResult.body },
        webhookEvents: { status: eventResult.response.status, ok: eventResult.response.ok, durationMs: eventResult.durationMs, rowCount: webhookEvents.length, error: eventResult.response.ok ? null : eventResult.body },
        schema: { status: schemaResult.response.status, ok: schemaResult.response.ok, durationMs: schemaResult.durationMs },
      }, schemaTables, recentSyncRuns: syncRuns, recentWebhookEvents: webhookEvents,
    } });
  } catch (error) {
    return NextResponse.json({ status: "error", services, clients: [], checkedAt, thresholds, error: error instanceof Error ? error.message : "Heartbeat check failed" }, { status: 502 });
  }
}
