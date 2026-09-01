// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { GRANOLA_DOWN_SECONDS, GRANOLA_TIMEZONE, granolaHeartbeatState } from "../../lib/granola-heartbeat";

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
    webhookFreshSeconds: 7 * 24 * 60 * 60,
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
    {
      id: "granola",
      label: "Granola API heartbeat",
      configured: false,
      status: "checking",
      detail: "",
      latencyMs: null as number | null,
    },
    {
      id: "slack",
      label: "Slack automations",
      configured: Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN),
      status: "checking",
      detail: "",
      latencyMs: null as number | null,
    },
    {
      id: "airtable",
      label: "Airtable API",
      configured: Boolean(process.env.AIRTABLE_API_KEY),
      status: "checking",
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
    /**
     * The window the enrichment usage figures are counted over.
     *
     * Usage lived on the analytics page and was counted over all of history, which meant the
     * headline call count kept climbing long after enrichment stopped running and could never
     * be reconciled against the 24-hour health verdict beside it. Two weeks is short enough to
     * describe the present and long enough to show a gap.
     */
    const usageWindowDays = 14;
    const usageStart = new Date(Date.now() - usageWindowDays * 24 * 60 * 60 * 1_000);
    usageStart.setHours(0, 0, 0, 0);
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
    /*
     * A live Slack auth check, not just "is a token set".
     *
     * `auth.test` returns HTTP 200 even for a bad token, with `{ ok: false, error: "invalid_auth" }` in the
     * body, so the verdict has to read `body.ok`, not the HTTP status. This is the whole automation surface —
     * if it is down, no brief and no call analysis posts — so it earns its own light rather than being inferred
     * from whether the last brief happened to succeed.
     */
    const slackToken = process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN;
    const slackStarted = Date.now();
    const slackApiCheck = slackToken
      ? fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: { Authorization: `Bearer ${slackToken}` },
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        })
          .then(async (response) => {
            const body = await safeJson(response);
            return {
              ok: Boolean(response.ok && body && (body as Row).ok),
              status: response.status,
              durationMs: Date.now() - slackStarted,
              body,
            };
          })
          .catch((error) => ({
            ok: false,
            status: 0,
            durationMs: Date.now() - slackStarted,
            body: error instanceof Error ? error.message : "Slack check failed",
          }))
      : Promise.resolve({ ok: false, status: 0, durationMs: 0, body: "No Slack token is set" });
    /*
     * A live Airtable check via `meta/whoami`, the cheapest authenticated call the token can make. Like Slack
     * and Anthropic, a set token is not a working token, and this is where every tracker and Weekly Calls write
     * lands, so it gets its own light.
     */
    const airtableToken = process.env.AIRTABLE_API_KEY;
    const airtableStarted = Date.now();
    const airtableCheck = airtableToken
      ? fetch("https://api.airtable.com/v0/meta/whoami", {
          headers: { Authorization: `Bearer ${airtableToken}` },
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        })
          .then(async (response) => ({
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - airtableStarted,
            body: await safeJson(response),
          }))
          .catch((error) => ({
            ok: false,
            status: 0,
            durationMs: Date.now() - airtableStarted,
            body: error instanceof Error ? error.message : "Airtable check failed",
          }))
      : Promise.resolve({ ok: false, status: 0, durationMs: 0, body: "No Airtable token is set" });
    const [
      workspaceResult,
      syncResult,
      eventResult,
      schemaResult,
      aiArkResult,
      aiArkUsageResult,
      recentLeadResult,
      slackBriefResult,
      granolaHeartbeatResult,
      anthropicResult,
      slackApiResult,
      airtableResult,
    ] = await Promise.all([
      request("rr_workspaces?select=*&slug=neq.misc&order=name.asc"),
      request("rr_sync_runs?select=*&order=started_at.desc&limit=25"),
      request("rr_webhook_events?select=*&order=received_at.desc&limit=25"),
      request(""),
      request(
        "rr_sync_runs?select=*&source=eq.ai_ark&run_type=eq.lead_enrichment&order=started_at.desc&limit=100",
      ),
      request(
        `rr_sync_runs?select=workspace_id,status,started_at&source=eq.ai_ark&run_type=eq.lead_enrichment&started_at=gte.${encodeURIComponent(usageStart.toISOString())}&order=started_at.desc&limit=5000`,
      ),
      request(
        `rr_leads?select=id,workspace_id,linkedin_profile_url,raw_data,created_at&linkedin_profile_url=not.is.null&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=1000`,
      ),
      /*
       * Every attempt at a Slack automation, successes and failures alike.
       *
       * `rr_slack_briefs` is the log rather than `rr_sync_runs` because that table is swept at 48 hours,
       * and an automation that stopped running on Friday is a thing somebody finds out about on Monday. The
       * body is not selected: the rows carry the full text of every brief, and this page only has to answer
       * whether the automation ran and whether Slack took it.
       */
      request(
        "rr_slack_briefs?select=id,workspace_id,automation,status,destination,slack_channel_id,error_text,created_at&order=created_at.desc&limit=60",
      ),
      /*
       * The Granola heartbeat's own log — the hourly poll's record of what it saw.
       *
       * Its own table, not `rr_sync_runs`, for the same reason the Slack log is separate: this table is not
       * swept, so a poll that stopped on Friday is still visible on Monday, and it carries the calls each hour
       * found, which is the thing the health card shows. Newest first; a handful is enough to show the trend.
       */
      request(
        "rr_granola_heartbeats?select=*&order=checked_at.desc&limit=12",
      ),
      anthropicCheck,
      slackApiCheck,
      airtableCheck,
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
    const aiArkUsageRuns = Array.isArray(aiArkUsageResult.body)
      ? (aiArkUsageResult.body as Row[])
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
    // A live ping can pass while every real call (drafts, scoring, sentiment) fails — so also read the last
    // 24h of Anthropic call outcomes from the audit log and flag the service down when most are failing.
    const anthropicAudit = await request(`rr_audit_log?select=details&actor_type=eq.anthropic&created_at=gte.${encodeURIComponent(since)}&limit=3000`).catch(() => ({ body: [] as Row[] }));
    const anthropicRows = Array.isArray(anthropicAudit.body) ? (anthropicAudit.body as Row[]) : [];
    const outcomeOf = (r: Row) => String(((r.details as Row) || {}).status || "");
    const anthropicFailed24h = anthropicRows.filter((r) => outcomeOf(r) === "failed").length;
    const anthropicSucceeded24h = anthropicRows.filter((r) => outcomeOf(r) === "success").length;
    const anthropicCalls24h = anthropicFailed24h + anthropicSucceeded24h;
    if (services[1].status === "healthy" && anthropicFailed24h > 5 && anthropicFailed24h >= anthropicSucceeded24h) {
      services[1].status = "down";
      services[1].detail = `Connected, but ${anthropicFailed24h} of ${anthropicCalls24h} Anthropic calls failed in the last 24h (reply drafts, scoring, sentiment). Check the model configured for the affected client.`;
    } else if (services[1].status === "healthy" && anthropicFailed24h > 0) {
      services[1].detail = `Live API request succeeded — ${anthropicSucceeded24h} of ${anthropicCalls24h} calls succeeded in the last 24h.`;
    }
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
    // Health is judged on enrichment runs only. A lead that has no ai_ark payload yet is a
    // normal, self-resolving backlog (leads arrive by webhook and are enriched afterwards,
    // and some profiles are simply not enrichable), so it is reported as information and
    // never drives the service down.
    const aiArkFailing =
      aiArkFailures24h.length > 5 &&
      aiArkFailures24h.length > aiArkSuccesses24h.length;
    const aiArkStatus = !aiArkEnabled
      ? "disabled"
      : !process.env.AI_ARK_API_KEY
        ? "not_configured"
        : !aiArkResult.response.ok || aiArkFailing
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
        ? aiArkSuccesses24h.length
          ? `${aiArkSuccesses24h.length} successful enrichment run(s) in the last 24 hours.`
          : "No enrichment failures in the last 24 hours."
        : aiArkStatus === "disabled"
          ? "Disabled globally."
          : "Recent enrichment runs are failing.";

    /*
     * The Slack automations, run by run.
     *
     * One line per attempt rather than a single "healthy" light, because the failure this exists to catch is
     * an automation that stopped: no error anywhere, just nothing since Thursday. A count of runs cannot show
     * that and a status cannot either. The list can, because the newest row carries its own date.
     */
    const slackBriefRows = Array.isArray(slackBriefResult.body)
      ? (slackBriefResult.body as Row[])
      : [];
    const nameBySlug = new Map(
      rows.map((row) => [String(row.id ?? ""), { name: String(row.name ?? ""), slug: String(row.slug ?? "") }]),
    );
    const slackRuns = slackBriefRows.map((row) => {
      const client = nameBySlug.get(String(row.workspace_id ?? ""));
      return {
        id: String(row.id ?? ""),
        automation: String(row.automation ?? "morning_brief"),
        // The workspace may since have been deleted, which is worth showing as a run that happened rather
        // than dropping: a brief posted for a client who is gone is itself the thing to look at.
        client: client?.name || "Unknown client",
        slug: client?.slug || "",
        status: String(row.status ?? ""),
        destination: String(row.destination ?? ""),
        channelId: String(row.slack_channel_id ?? ""),
        error: row.error_text ? String(row.error_text) : "",
        at: row.created_at ? String(row.created_at) : null,
        ageSeconds: ageSeconds(row.created_at),
      };
    });
    // A preview is somebody checking a prompt, not the automation running, so it is not counted either way.
    const delivered = slackRuns.filter((run) => run.destination !== "preview");
    const lastDelivered = delivered[0] ?? null;
    const slack = {
      configured: Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN),
      testChannelConfigured: Boolean(process.env.SLACK_TEST_CHANNEL_ID),
      readable: slackBriefResult.response.ok,
      attempts: delivered.length,
      failures: delivered.filter((run) => run.status !== "sent").length,
      lastRunAt: lastDelivered?.at ?? null,
      lastRunAgeSeconds: lastDelivered?.ageSeconds ?? null,
      lastFailureAt: delivered.find((run) => run.status !== "sent")?.at ?? null,
      // The table may not exist yet on a database that has not had the migration run, which is a different
      // thing from an automation that has never run, and only one of the two is somebody's job to fix.
      error: slackBriefResult.response.ok ? null : `The Slack automation log could not be read (HTTP ${slackBriefResult.response.status}).`,
      runs: slackRuns.slice(0, 30),
    };

    /*
     * The Granola heartbeat: what the hourly poll last saw, and whether it is late.
     *
     * "Down" is only a verdict inside the 5am–8pm Eastern window — outside it the worker deliberately does
     * not poll, so a six-hour-old heartbeat overnight is the system working, not failing. `granolaHeartbeatState`
     * owns that rule; here we only read the newest stored poll and hand it the clock. The service light in the
     * top grid is green when the state is ok, idle (paused overnight) or still starting up, and red only on down.
     */
    const granolaRows = Array.isArray(granolaHeartbeatResult.body) ? (granolaHeartbeatResult.body as Row[]) : [];
    const latestGranola = granolaRows[0] ?? null;
    const granolaState = granolaHeartbeatState({
      lastCheckedAt: latestGranola ? String(latestGranola.checked_at ?? "") : null,
      downSeconds: GRANOLA_DOWN_SECONDS,
    });
    const granolaClients = Array.isArray(latestGranola?.clients) ? (latestGranola.clients as Row[]) : [];
    const granola = {
      state: granolaState.state,
      inWindow: granolaState.inWindow,
      timezone: GRANOLA_TIMEZONE,
      windowLabel: "5:00 AM – 8:00 PM Eastern, every day",
      downThresholdSeconds: GRANOLA_DOWN_SECONDS,
      pollIntervalLabel: "Every hour",
      readable: granolaHeartbeatResult.response.ok,
      lastCheckedAt: latestGranola ? String(latestGranola.checked_at ?? "") : null,
      lastCheckedAgeSeconds: granolaState.ageSeconds,
      keysSeen: Number(latestGranola?.keys_seen ?? 0),
      clientsChecked: Number(latestGranola?.clients_checked ?? 0),
      callsFound: Number(latestGranola?.calls_found ?? 0),
      newCalls: Number(latestGranola?.new_calls ?? 0),
      error: latestGranola?.error_text ? String(latestGranola.error_text) : null,
      // The calls the last poll saw, so the card can name each client and the meeting found for them.
      clients: granolaClients.map((client) => ({
        slug: String(client.slug ?? ""),
        name: String(client.name ?? ""),
        title: client.title ? String(client.title) : null,
        startedAt: client.startedAt ?? null,
        ageDays: client.ageDays ?? null,
        owner: client.owner ? String(client.owner) : null,
        isNew: Boolean(client.isNew),
      })),
      // The recent polls, newest first, so an absence of rows is itself visible as the poll having stopped.
      recentChecks: granolaRows.map((row) => ({
        checkedAt: row.checked_at ? String(row.checked_at) : null,
        inWindow: Boolean(row.in_window),
        keysSeen: Number(row.keys_seen ?? 0),
        clientsChecked: Number(row.clients_checked ?? 0),
        callsFound: Number(row.calls_found ?? 0),
        newCalls: Number(row.new_calls ?? 0),
        status: String(row.status ?? ""),
      })),
    };
    // Green whenever the poll is doing what it should — running (ok), paused overnight (idle) or waiting for
    // its first cycle (starting). Red only when it is inside working hours and has gone silent for six hours.
    services[4].status = granolaState.state === "down" ? "down" : "healthy";
    services[4].configured = granolaState.state !== "down";
    services[4].detail =
      granolaState.state === "down"
        ? "No Granola poll has been recorded for over six hours during working hours."
        : granolaState.state === "idle"
          ? "Paused outside working hours (5 AM – 8 PM Eastern)."
          : granolaState.state === "starting"
            ? "Waiting for the first hourly poll."
            : `Last poll ${granola.callsFound} call(s) across ${granola.clientsChecked} client(s).`;
    // Slack: the token is only useful if Slack accepts it, so the light is the live auth.test verdict.
    services[5].status = !services[5].configured
      ? "down"
      : slackApiResult.ok
        ? "healthy"
        : "down";
    services[5].detail = !services[5].configured
      ? "No Slack token is set (SLACK_BOT_TOKEN)."
      : slackApiResult.ok
        ? "Slack accepted the token."
        : `Slack rejected the token or is unreachable${slackApiResult.status ? ` (HTTP ${slackApiResult.status})` : ""}.`;
    services[5].latencyMs = slackApiResult.durationMs;
    // Airtable: same shape — a set token that Airtable rejects is still down.
    services[6].status = !services[6].configured
      ? "down"
      : airtableResult.ok
        ? "healthy"
        : "down";
    services[6].detail = !services[6].configured
      ? "No Airtable token is set (AIRTABLE_API_KEY)."
      : airtableResult.ok
        ? "Airtable accepted the token."
        : `Airtable rejected the token or is unreachable${airtableResult.status ? ` (HTTP ${airtableResult.status})` : ""}.`;
    services[6].latencyMs = airtableResult.durationMs;

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
              ? "Webhook down — no reply has ever arrived."
              : "Webhook down — no reply has arrived for more than one week.",
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
            : !aiArkResult.response.ok
              ? "The health check could not read AI Ark run data from Supabase."
              : aiArkStatus === "attention"
                ? `${aiArkFailures24h.length} enrichment run(s) failed in the last 24 hours and failures now outnumber successes. Check the failures below.`
                : "AI Ark is enriching leads normally.",
      recentFailures: aiArkFailures24h.slice(0, 10).map((run) => ({
        startedAt: run.started_at,
        workspaceId: run.workspace_id,
        error: run.error_text,
      })),
      recentRuns: aiArkRuns.slice(0, 25),
      usage: {
        windowDays: usageWindowDays,
        calls: aiArkUsageRuns.length,
        successes: aiArkUsageRuns.filter((run) => run.status === "success").length,
        failures: aiArkUsageRuns.filter((run) => run.status === "failed").length,
        byClient: rows
          .map((workspace) => {
            const runs = aiArkUsageRuns.filter(
              (run) => String(run.workspace_id) === String(workspace.id),
            );
            return {
              name: String(workspace.name),
              slug: String(workspace.slug),
              calls: runs.length,
              successes: runs.filter((run) => run.status === "success").length,
              failures: runs.filter((run) => run.status === "failed").length,
            };
          })
          .filter((client) => client.calls > 0)
          .sort((a, b) => b.calls - a.calls),
      },
    };
    return NextResponse.json({
      status: "live",
      services,
      clients,
      worker,
      aiArk,
      slack,
      granola,
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
