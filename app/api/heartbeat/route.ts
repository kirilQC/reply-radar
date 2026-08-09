import { NextResponse } from "next/server";

type Row = Record<string, unknown>;
const ageSeconds = (value: unknown) =>
  value
    ? Math.max(
        0,
        Math.floor((Date.now() - new Date(String(value)).getTime()) / 1000),
      )
    : null;
const safeJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text.trim()) return [];
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: true, responseText: text.slice(0, 2_000) };
  }
};

export async function GET() {
  const checkedAt = new Date().toISOString();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const thresholds = {
    workerFreshSeconds: 300,
    webhookFreshSeconds: 1800,
    pollFreshSeconds: 3600,
  };
  const aiArkEnabled = ["1", "true", "yes", "on"].includes(
    String(process.env.AI_ARK_ENRICHMENT_ENABLED ?? "")
      .trim()
      .toLowerCase(),
  );
  const services = [
    {
      id: "supabase",
      label: "Supabase database",
      configured: Boolean(url && key),
      status: "checking",
      detail: "",
      latencyMs: null as number | null,
    },
    {
      id: "anthropic",
      label: "Anthropic API",
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      status: "checking",
      detail: "",
      latencyMs: null as number | null,
    },
    {
      id: "worker",
      label: "Render worker",
      configured: false,
      status: "checking",
      detail: "",
      latencyMs: null as number | null,
    },
    {
      id: "ai_ark",
      label: "AI Ark enrichment",
      configured: !aiArkEnabled || Boolean(process.env.AI_ARK_API_KEY),
      status: aiArkEnabled ? "checking" : "disabled",
      detail: "",
      latencyMs: null as number | null,
    },
  ];
  if (!url || !key)
    return NextResponse.json({
      status: "not_configured",
      services,
      clients: [],
      checkedAt,
      thresholds,
      diagnostics: {
        runtime: {
          node: process.version,
          supabaseUrlConfigured: Boolean(url),
          serviceRoleKeyConfigured: Boolean(key),
          anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
          workerServiceUrlConfigured: Boolean(process.env.WORKER_SERVICE_URL),
        },
      },
    });

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const request = async (path: string) => {
    const started = Date.now();
    const response = await fetch(`${url}/rest/v1/${path}`, {
      headers,
      cache: "no-store",
    });
    return {
      response,
      body: await safeJson(response),
      durationMs: Date.now() - started,
    };
  };

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const anthropicStarted = Date.now();
    const anthropicCheck = process.env.ANTHROPIC_API_KEY
      ? fetch("https://api.anthropic.com/v1/models?limit=1", {
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        })
          .then(async (response) => ({
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - anthropicStarted,
            body: await safeJson(response),
          }))
          .catch((error) => ({
            ok: false,
            status: 0,
            durationMs: Date.now() - anthropicStarted,
            body:
              error instanceof Error ? error.message : "Anthropic check failed",
          }))
      : Promise.resolve({
          ok: false,
          status: 0,
          durationMs: 0,
          body: "API key missing",
        });
    const [
      workspaceResult,
      syncResult,
      eventResult,
      schemaResult,
      aiArkResult,
      recentLeadResult,
      anthropicResult,
    ] = await Promise.all([
      request("rr_workspaces?select=*&order=name.asc"),
      request("rr_sync_runs?select=*&order=started_at.desc&limit=25"),
      request("rr_webhook_events?select=*&order=received_at.desc&limit=25"),
      request(""),
      request(
        "rr_sync_runs?select=*&source=eq.ai_ark&run_type=eq.lead_enrichment&order=started_at.desc&limit=100",
      ),
      request(
        `rr_leads?select=id,workspace_id,linkedin_profile_url,raw_data,created_at&linkedin_profile_url=not.is.null&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=1000`,
      ),
      anthropicCheck,
    ]);
    services[0].status = workspaceResult.response.ok ? "healthy" : "down";
    services[0].detail = workspaceResult.response.ok
      ? "Live query succeeded."
      : `Query returned ${workspaceResult.response.status}.`;
    services[0].latencyMs = workspaceResult.durationMs;
    if (!workspaceResult.response.ok)
      throw new Error(
        `Workspace query failed (${workspaceResult.response.status})`,
      );
    const rows = Array.isArray(workspaceResult.body)
      ? (workspaceResult.body as Row[])
      : [];
    const syncRuns = Array.isArray(syncResult.body)
      ? (syncResult.body as Row[])
      : [];
    const webhookEvents = Array.isArray(eventResult.body)
      ? (eventResult.body as Row[])
      : [];
    const aiArkRuns = Array.isArray(aiArkResult.body)
      ? (aiArkResult.body as Row[])
      : [];
    const recentLeads = Array.isArray(recentLeadResult.body)
      ? (recentLeadResult.body as Row[])
      : [];
    const workerRun = syncRuns.find(
      (run) =>
        run.source === "render-worker-heartbeat" ||
        run.run_type === "heartbeat",
    );
    const workerAgeSeconds = ageSeconds(workerRun?.started_at);
    services[2].configured =
      workerAgeSeconds !== null &&
      workerAgeSeconds <= thresholds.workerFreshSeconds;
    services[1].status = anthropicResult.ok ? "healthy" : "down";
    services[1].detail = anthropicResult.ok
      ? "Live API request succeeded."
      : process.env.ANTHROPIC_API_KEY
        ? `Live API request returned ${anthropicResult.status || "an error"}.`
        : "API key is missing.";
    services[1].latencyMs = anthropicResult.durationMs;
    services[2].status = services[2].configured ? "healthy" : "down";
    services[2].detail = services[2].configured
      ? "A fresh worker heartbeat is stored."
      : "No fresh worker heartbeat is stored.";
    const aiArkFailures24h = aiArkRuns.filter(
      (run) =>
        run.status === "failed" &&
        new Date(String(run.started_at)).getTime() >= new Date(since).getTime(),
    );
    const aiArkSuccesses24h = aiArkRuns.filter(
      (run) =>
        run.status === "success" &&
        new Date(String(run.started_at)).getTime() >= new Date(since).getTime(),
    );
    const unenrichedLeads24h = recentLeads.filter((lead) => {
      const raw =
        lead.raw_data &&
        typeof lead.raw_data === "object" &&
        !Array.isArray(lead.raw_data)
          ? (lead.raw_data as Row)
          : {};
      const metadata =
        raw.reply_radar &&
        typeof raw.reply_radar === "object" &&
        !Array.isArray(raw.reply_radar)
          ? (raw.reply_radar as Row)
          : {};
      const enrichment =
        metadata.ai_ark &&
        typeof metadata.ai_ark === "object" &&
        !Array.isArray(metadata.ai_ark)
          ? (metadata.ai_ark as Row)
          : {};
      return Object.keys(enrichment).length === 0;
    });
    const aiArkProblemCount = Math.max(
      aiArkFailures24h.length,
      unenrichedLeads24h.length,
    );
    const aiArkStatus = !aiArkEnabled
      ? "disabled"
      : !process.env.AI_ARK_API_KEY
        ? "not_configured"
        : !aiArkResult.response.ok ||
            !recentLeadResult.response.ok ||
            aiArkProblemCount > 5
          ? "attention"
          : "healthy";
    services[3].status =
      aiArkStatus === "healthy"
        ? "healthy"
        : aiArkStatus === "disabled"
          ? "disabled"
          : "down";
    services[3].detail =
      aiArkStatus === "healthy"
        ? "Recent enrichment records are healthy."
        : aiArkStatus === "disabled"
          ? "Disabled globally."
          : "Recent enrichment data needs attention.";

    const clients = rows.map((row) => {
      const webhookAgeSeconds = ageSeconds(row.last_webhook_received_at);
      const pollAgeSeconds = ageSeconds(row.last_successful_poll_at);
      const keyConfigured = Boolean(row.heyreach_api_key_ciphertext);
      const webhookHealthy =
        webhookAgeSeconds !== null &&
        webhookAgeSeconds <= thresholds.webhookFreshSeconds;
      const pollHealthy =
        pollAgeSeconds !== null &&
        pollAgeSeconds <= thresholds.pollFreshSeconds;
      const recentRuns = syncRuns
        .filter((run) => run.workspace_id === row.id)
        .slice(0, 10);
      const recentEvents = webhookEvents
        .filter((event) => event.workspace_id === row.id)
        .slice(0, 10);
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        logoUrl: row.logo_url ?? null,
        websiteUrl: row.website_url ?? null,
        keyConfigured,
        webhookAgeSeconds,
        pollAgeSeconds,
        lastWebhookReceivedAt: row.last_webhook_received_at ?? null,
        lastSuccessfulPollAt: row.last_successful_poll_at ?? null,
        lastReconciledAt: row.last_reconciled_at ?? null,
        webhookStatus: !keyConfigured
          ? "Add a HeyReach API key first."
          : webhookHealthy
            ? "Replies are reaching Reply Radar."
            : webhookAgeSeconds === null
              ? "No webhook has arrived yet."
              : "No webhook has arrived recently.",
        pollStatus: pollHealthy
          ? "The background check ran recently."
          : pollAgeSeconds === null
            ? "The background check has never finished."
            : "The background check is late.",
        status:
          keyConfigured && webhookHealthy && pollHealthy
            ? "healthy"
            : keyConfigured
              ? "attention"
              : "missing",
        recentRuns,
        recentEvents,
        raw: {
          ...row,
          heyreach_api_key_ciphertext: keyConfigured
            ? "[configured — hidden]"
            : null,
          webhook_secret_hash: row.webhook_secret_hash
            ? "[configured — hidden]"
            : null,
        },
      };
    });
    const worker = workerRun
      ? {
          status:
            workerAgeSeconds !== null &&
            workerAgeSeconds <= thresholds.workerFreshSeconds
              ? "running"
              : "stale",
          recordedStatus: workerRun.status,
          ageSeconds: workerAgeSeconds,
          startedAt: workerRun.started_at ?? null,
          finishedAt: workerRun.finished_at ?? null,
          durationSeconds:
            workerRun.finished_at && workerRun.started_at
              ? Math.max(
                  0,
                  (new Date(String(workerRun.finished_at)).getTime() -
                    new Date(String(workerRun.started_at)).getTime()) /
                    1000,
                )
              : null,
          workspacesSeen: workerRun.records_seen ?? 0,
          recordsWritten: workerRun.records_written ?? 0,
          source: workerRun.source ?? null,
          runType: workerRun.run_type ?? null,
          error: workerRun.error_text ?? null,
          recentRuns: syncRuns.slice(0, 15),
          raw: workerRun,
        }
      : null;
    const definitions =
      schemaResult.body &&
      typeof schemaResult.body === "object" &&
      "definitions" in schemaResult.body
        ? ((
            schemaResult.body as {
              definitions?: Record<
                string,
                { properties?: Record<string, unknown>; required?: string[] }
              >;
            }
          ).definitions ?? {})
        : {};
    const schemaTables = [
      "rr_workspaces",
      "rr_leads",
      "rr_conversations",
      "rr_messages",
      "rr_webhook_events",
      "rr_sync_runs",
    ].reduce<Record<string, unknown>>((result, table) => {
      result[table] = {
        columns: Object.keys(definitions[table]?.properties ?? {}),
        required: definitions[table]?.required ?? [],
      };
      return result;
    }, {});
    const aiArk = {
      status: aiArkStatus,
      enabled: aiArkEnabled,
      configured: Boolean(process.env.AI_ARK_API_KEY),
      failureThreshold: 5,
      failures24h: aiArkFailures24h.length,
      successes24h: aiArkSuccesses24h.length,
      calls24h: aiArkFailures24h.length + aiArkSuccesses24h.length,
      unenrichedLeads24h: unenrichedLeads24h.length,
      explanation:
        aiArkStatus === "disabled"
          ? "Enrichment is intentionally turned off in Vercel."
          : aiArkStatus === "not_configured"
            ? "Enrichment is on, but the AI_ARK_API_KEY is missing."
            : !aiArkResult.response.ok || !recentLeadResult.response.ok
              ? "The health check could not read AI Ark run or lead data from Supabase."
              : aiArkStatus === "attention"
                ? `More than 5 recent leads could not be enriched. Check the failures below.`
                : "AI Ark is enriching leads normally.",
      recentFailures: aiArkFailures24h.slice(0, 10).map((run) => ({
        startedAt: run.started_at,
        workspaceId: run.workspace_id,
        error: run.error_text,
      })),
      recentRuns: aiArkRuns.slice(0, 25),
    };
    return NextResponse.json({
      status: "live",
      services,
      clients,
      worker,
      aiArk,
      checkedAt,
      thresholds,
      diagnostics: {
        runtime: {
          node: process.version,
          supabaseUrlConfigured: true,
          serviceRoleKeyConfigured: true,
          anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
          aiArkKeyConfigured: Boolean(process.env.AI_ARK_API_KEY),
          aiArkEnrichmentEnabled: aiArkEnabled,
          workerServiceUrlConfigured: Boolean(process.env.WORKER_SERVICE_URL),
          pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS || 120),
        },
        queries: {
          workspaces: {
            status: workspaceResult.response.status,
            ok: workspaceResult.response.ok,
            durationMs: workspaceResult.durationMs,
            rowCount: rows.length,
          },
          syncRuns: {
            status: syncResult.response.status,
            ok: syncResult.response.ok,
            durationMs: syncResult.durationMs,
            rowCount: syncRuns.length,
            error: syncResult.response.ok ? null : syncResult.body,
          },
          webhookEvents: {
            status: eventResult.response.status,
            ok: eventResult.response.ok,
            durationMs: eventResult.durationMs,
            rowCount: webhookEvents.length,
            error: eventResult.response.ok ? null : eventResult.body,
          },
          aiArkRuns: {
            status: aiArkResult.response.status,
            ok: aiArkResult.response.ok,
            durationMs: aiArkResult.durationMs,
            rowCount: aiArkRuns.length,
            error: aiArkResult.response.ok ? null : aiArkResult.body,
          },
          recentLeads: {
            status: recentLeadResult.response.status,
            ok: recentLeadResult.response.ok,
            durationMs: recentLeadResult.durationMs,
            rowCount: recentLeads.length,
            error: recentLeadResult.response.ok ? null : recentLeadResult.body,
          },
          schema: {
            status: schemaResult.response.status,
            ok: schemaResult.response.ok,
            durationMs: schemaResult.durationMs,
          },
          anthropic: anthropicResult,
        },
        schemaTables,
        recentSyncRuns: syncRuns,
        recentWebhookEvents: webhookEvents,
      },
    });
  } catch (error) {
    services[0].status = "down";
    services[0].detail =
      error instanceof Error ? error.message : "Supabase check failed";
    return NextResponse.json(
      {
        status: "error",
        services,
        clients: [],
        checkedAt,
        thresholds,
        error:
          error instanceof Error ? error.message : "Heartbeat check failed",
      },
      { status: 502 },
    );
  }
}
