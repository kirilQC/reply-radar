// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useCallback, useEffect, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";

type Service = {
  id: string;
  label: string;
  configured: boolean;
  status?: "checking" | "healthy" | "down" | "disabled";
  detail?: string;
  latencyMs?: number | null;
};
type Heartbeat = {
  status?: string;
  services?: Service[];
  checkedAt?: string;
  thresholds?: { webhookFreshSeconds?: number; pollFreshSeconds?: number };
  clients?: Array<{
    name: string;
    slug: string;
    logoUrl?: string | null;
    keyConfigured: boolean;
    webhookAgeSeconds: number | null;
    pollAgeSeconds: number | null;
    lastWebhookReceivedAt?: string | null;
    lastSuccessfulPollAt?: string | null;
    status: string;
    webhookStatus?: string;
    pollStatus?: string;
    raw?: Record<string, unknown>;
  }>;
  worker?: {
    status?: string;
    ageSeconds: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    workspacesSeen?: number;
    error?: string | null;
    pollIntervalSeconds?: number;
    raw?: Record<string, unknown>;
  } | null;
  aiArk?: {
    status: "healthy" | "attention" | "disabled" | "not_configured";
    enabled: boolean;
    configured: boolean;
    failureThreshold: number;
    failures24h: number;
    successes24h: number;
    calls24h: number;
    unenrichedLeads24h: number;
    explanation: string;
    recentFailures?: Array<{
      startedAt?: string;
      workspaceId?: string;
      error?: string;
    }>;
    recentRuns?: Array<Record<string, unknown>>;
    usage?: {
      windowDays: number;
      calls: number;
      successes: number;
      failures: number;
      byClient: Array<{
        name: string;
        slug: string;
        calls: number;
        successes: number;
        failures: number;
      }>;
    };
  };
  /**
   * Every Slack automation attempt, successes and failures alike, newest first.
   *
   * A brief that silently stopped posting looks identical to a quiet week from the outside, which is
   * why this is a log of attempts rather than a status: the absence of a run is the failure worth
   * seeing, and only a list with times in it makes an absence visible.
   */
  slack?: {
    configured: boolean;
    testChannelConfigured: boolean;
    readable: boolean;
    attempts: number;
    failures: number;
    lastRunAt: string | null;
    lastRunAgeSeconds: number | null;
    lastFailureAt: string | null;
    error: string | null;
    runs?: Array<{
      id: string;
      automation: string;
      client: string;
      slug: string;
      status: string;
      destination: string;
      channelId: string;
      error: string;
      at: string | null;
      ageSeconds: number | null;
    }>;
  };
  /**
   * The Granola heartbeat: the hourly, working-hours poll that finds each client's newest call and posts an
   * analysis for any it has not posted before. `state` is the whole verdict — down only when the poll has
   * gone silent for six hours inside the window, idle overnight, ok while it is running.
   */
  granola?: {
    state: "idle" | "starting" | "ok" | "down";
    inWindow: boolean;
    timezone: string;
    windowLabel: string;
    pollIntervalLabel: string;
    downThresholdSeconds: number;
    readable: boolean;
    lastCheckedAt: string | null;
    lastCheckedAgeSeconds: number | null;
    keysSeen: number;
    clientsChecked: number;
    callsFound: number;
    newCalls: number;
    error: string | null;
    clients?: Array<{
      slug: string;
      name: string;
      title: string | null;
      startedAt: number | null;
      ageDays: number | null;
      owner: string | null;
      isNew: boolean;
    }>;
    recentChecks?: Array<{
      checkedAt: string | null;
      inWindow: boolean;
      keysSeen: number;
      clientsChecked: number;
      callsFound: number;
      newCalls: number;
      status: string;
    }>;
  };
};

const formatAge = (seconds: number | null | undefined) => {
  if (seconds == null) return "No check recorded yet";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
};

const formatTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "Not recorded";

/** Where a run went, in the words the Slack tab uses, so the two pages cannot disagree. */
const destinationLabel = (destination: string) =>
  destination === "internal"
    ? "Internal channel"
    : destination === "test"
      ? "Test channel"
      : destination === "preview"
        ? "Preview only"
        : destination || "Unknown";

/** The exact moment, short enough to sit on one row of a list of thirty. */
const formatStamp = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "No time recorded";

const formatElapsed = (seconds: number | null) => {
  if (seconds == null) return "Waiting for the first check";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
};

export default function HealthPage() {
  const [mode, setMode] = useState<"basic" | "advanced">("basic");
  const [heartbeat, setHeartbeat] = useState<Heartbeat>({});
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/heartbeat", { cache: "no-store" });
      setHeartbeat(await response.json().catch(() => ({ status: "error" })));
    } catch {
      setHeartbeat({ status: "offline" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const services = heartbeat.services ?? [];
  const aiArkHealthy =
    !heartbeat.aiArk ||
    ["healthy", "disabled"].includes(heartbeat.aiArk.status);
  // Mirrors the heartbeat rule: runs are only failing when there are more than a handful
  // of failures and they outnumber the successes.
  const aiArkRunsFailing =
    (heartbeat.aiArk?.failures24h ?? 0) > 5 &&
    (heartbeat.aiArk?.failures24h ?? 0) > (heartbeat.aiArk?.successes24h ?? 0);
  /*
   * Three states, not two, and the third is the one that matters.
   *
   * A Slack automation is only unhealthy when it tried and failed. Never having run is separate —
   * "the schedule has not fired yet" and "the schedule fired and broke" are different jobs. And when
   * the heartbeat returns no Slack block at all, which is what happens before Supabase is configured,
   * nothing is known either way: claiming the token is missing would be inventing a diagnosis, and a
   * health page that guesses is worse than one that says it did not look.
   */
  const slack = heartbeat.slack;
  const slackRuns = slack?.runs ?? [];
  const slackFailing = Boolean(slack && slack.failures > 0);
  const slackState = !slack
    ? "neutral"
    : !slack.configured || !slack.readable || slackFailing
      ? "missing"
      : slack.attempts === 0
        ? "neutral"
        : "ready";
  /*
   * The Granola heartbeat's state maps straight to a badge class: down is the only alarm, idle (paused
   * overnight) and starting are quiet, ok is green. The badge classes are the same ones the Slack and
   * AI Ark panels use, so the health page reads consistently top to bottom.
   */
  const granola = heartbeat.granola;
  const granolaState = !granola
    ? "neutral"
    : granola.state === "ok"
      ? "ready"
      : granola.state === "down"
        ? "missing"
        : "neutral";

  const clients = heartbeat.clients ?? [];
  const clientCount = clients.length;
  const attentionCount = clients.filter(
    (client) => client.status !== "healthy",
  ).length;
  const successfulCount = clientCount - attentionCount;
  const healthy =
    heartbeat.status === "live" &&
    services.every(
      (service) =>
        service.status === "healthy" || service.status === "disabled",
    ) &&
    aiArkHealthy &&
    heartbeat.worker?.status === "running" &&
    attentionCount === 0;
  const checkedAtMs = heartbeat.checkedAt
    ? new Date(heartbeat.checkedAt).getTime()
    : Number.NaN;
  const checkAgeSeconds = Number.isFinite(checkedAtMs)
    ? Math.max(0, Math.floor((clock - checkedAtMs) / 1_000))
    : null;

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "System health" }]} />
          <div className="top-actions">
            <GlobalAppearanceControl />
          </div>
        </header>
        <main className="admin-shell health-shell">
          <section className="admin-content">
            <div className="admin-heading">
              <div>
                <h1>System Health</h1>
              </div>
              <div className="health-actions">
                <div className="health-refresh-meta" aria-live="polite">
                  <strong>
                    Time since last check: {formatElapsed(checkAgeSeconds)}
                  </strong>
                  <span>Checks refresh automatically every 30 seconds.</span>
                </div>
                <div className="health-action-row">
                  <div
                    className="segmented-control"
                    role="tablist"
                    aria-label="Heartbeat detail level"
                  >
                    <button
                      className={mode === "basic" ? "active" : ""}
                      onClick={() => setMode("basic")}
                    >
                      Basic view
                    </button>
                    <button
                      className={mode === "advanced" ? "active" : ""}
                      onClick={() => setMode("advanced")}
                    >
                      Advanced view
                    </button>
                  </div>
                  <button
                    className="primary-button"
                    onClick={refresh}
                    disabled={loading}
                  >
                    {loading ? "Checking…" : "Refresh checks ↻"}
                  </button>
                </div>
              </div>
            </div>

            <div className="workspace-cards heartbeat-summary">
              <HealthCard
                label="Total clients connected"
                value={String(clientCount)}
                tone={healthy ? "ok" : "warn"}
              />
              <HealthCard
                label="Clients successfully running"
                value={String(successfulCount)}
                tone={successfulCount === clientCount ? "ok" : "warn"}
              />
              <HealthCard
                label="Clients needing action"
                value={String(attentionCount)}
                tone={attentionCount ? "warn" : "ok"}
              />
            </div>

            <section className="admin-panel heartbeat-explainer">
              <div className="panel-heading">
                <div>
                  <h2>Core services</h2>
                </div>
              </div>
              <div className="heartbeat-service-grid">
                {services.map((service) => (
                  <div
                    className={`heartbeat-service ${service.status === "healthy" || service.status === "disabled" ? "service-ok" : "service-down"}`}
                    key={service.id}
                    title={service.detail || undefined}
                  >
                    <span
                      className={`status-dot ${service.status === "healthy" || service.status === "disabled" ? "ok" : "warn"}`}
                    />
                    <strong>{service.label}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="admin-panel worker-heartbeat-panel">
              <div className="panel-heading">
                <div>
                  <h2>Worker heartbeat</h2>
                </div>
                <span
                  className={`health-state ${heartbeat.worker?.status === "running" ? "ready" : "missing"}`}
                >
                  {heartbeat.worker?.status === "running"
                    ? "RUNNING"
                    : "WAITING"}
                </span>
              </div>
              {heartbeat.worker ? (
                <div className="heartbeat-log-list">
                  <div>
                    <strong>Latest check</strong>
                    <span>
                      {formatAge(heartbeat.worker.ageSeconds)} ·{" "}
                      {heartbeat.worker.workspacesSeen ?? 0} client(s) checked
                    </span>
                  </div>
                  <div>
                    <strong>Started</strong>
                    <span>{formatTime(heartbeat.worker.startedAt)}</span>
                  </div>
                  <div>
                    <strong>Finished</strong>
                    <span>{formatTime(heartbeat.worker.finishedAt)}</span>
                  </div>
                  {heartbeat.worker.error && (
                    <div>
                      <strong>Last error</strong>
                      <span className="error-text">
                        {heartbeat.worker.error}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="empty-state">
                  No worker check has been recorded yet. Deploy the Render
                  worker and wait for its first cycle.
                </p>
              )}
              {mode === "advanced" && heartbeat.worker && (
                <details className="diagnostic-details" open>
                  <summary>Raw worker record</summary>
                  <pre>
                    {JSON.stringify(
                      heartbeat.worker.raw ?? heartbeat.worker,
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </section>

            <section
              className={`admin-panel ai-ark-health ${heartbeat.aiArk?.status === "attention" || heartbeat.aiArk?.status === "not_configured" ? "has-alert" : ""}`}
            >
              <div className="panel-heading">
                <div>
                  <h2>AI Ark enrichment</h2>
                </div>
                <span
                  className={`health-state ${heartbeat.aiArk?.status === "healthy" ? "ready" : heartbeat.aiArk?.status === "disabled" ? "neutral" : "missing"}`}
                >
                  {heartbeat.aiArk?.status === "healthy"
                    ? "HEALTHY"
                    : heartbeat.aiArk?.status === "disabled"
                      ? "DISABLED"
                      : "NEEDS ATTENTION"}
                </span>
              </div>
              <div className="heartbeat-kid-grid ai-ark-health-grid">
                <div
                  className={
                    heartbeat.aiArk?.configured || !heartbeat.aiArk?.enabled
                      ? "ok"
                      : "bad"
                  }
                >
                  <b>
                    {heartbeat.aiArk?.configured || !heartbeat.aiArk?.enabled
                      ? "✓"
                      : "!"}
                  </b>
                  <span>
                    <strong>API connection</strong>
                    <small>
                      {heartbeat.aiArk?.enabled
                        ? heartbeat.aiArk?.configured
                          ? "The AI Ark key is configured."
                          : "The AI Ark key is missing."
                        : "Calls are disabled globally."}
                    </small>
                  </span>
                </div>
                <div className={aiArkRunsFailing ? "bad" : "ok"}>
                  <b>{aiArkRunsFailing ? "!" : "✓"}</b>
                  <span>
                    <strong>API results · 24 hours</strong>
                    <small>
                      {heartbeat.aiArk?.successes24h ?? 0} succeeded ·{" "}
                      {heartbeat.aiArk?.failures24h ?? 0} failed
                    </small>
                  </span>
                </div>
                {/* Informational only: leads are enriched asynchronously after they arrive,
                    so a pending backlog is normal and never marks the service down. */}
                <div className="ok">
                  <b>i</b>
                  <span>
                    <strong>Enrichment backlog</strong>
                    <small>
                      {heartbeat.aiArk?.unenrichedLeads24h ?? 0} recent LinkedIn
                      lead(s) still waiting on enrichment.
                    </small>
                  </span>
                </div>
              </div>
              {/* Usage sat on the analytics page, where it was counted over all of history and
                  so could never be squared with the 24-hour verdict above. It belongs next to
                  that verdict, over a window that is stated rather than assumed. */}
              <div className="ai-ark-usage">
                <div className="ai-ark-usage-heading">
                  <h3>Enrichment usage</h3>
                  <span>
                    Last {heartbeat.aiArk?.usage?.windowDays ?? 14} days ·
                    provider calls only, cached profiles are not counted
                  </span>
                </div>
                <div className="ai-ark-usage-summary">
                  <div>
                    <span>Successful</span>
                    <strong>
                      {(heartbeat.aiArk?.usage?.successes ?? 0).toLocaleString()}
                    </strong>
                  </div>
                  <div>
                    <span>Failed</span>
                    <strong>
                      {(heartbeat.aiArk?.usage?.failures ?? 0).toLocaleString()}
                    </strong>
                  </div>
                  <div>
                    <span>Total calls</span>
                    <strong>
                      {(heartbeat.aiArk?.usage?.calls ?? 0).toLocaleString()}
                    </strong>
                  </div>
                </div>
                {heartbeat.aiArk?.usage?.byClient?.length ? (
                  <div className="ai-ark-usage-clients">
                    {heartbeat.aiArk.usage.byClient.map((client) => (
                      <div key={client.slug}>
                        <strong>{client.name}</strong>
                        <span>{client.calls.toLocaleString()} calls</span>
                        <em className={client.failures ? "failed" : "healthy"}>
                          {client.failures
                            ? `${client.failures} failed`
                            : "Healthy"}
                        </em>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state">
                    No enrichment calls in this window.
                  </p>
                )}
              </div>
              {mode === "advanced" && (
                <details className="diagnostic-details" open>
                  <summary>
                    AI Ark calls, failures, thresholds, and sanitized run
                    records
                  </summary>
                  <pre>{JSON.stringify(heartbeat.aiArk ?? null, null, 2)}</pre>
                </details>
              )}
            </section>

            <section
              className={`admin-panel slack-automation-health ${slackState === "missing" ? "has-alert" : ""}`}
            >
              <div className="panel-heading">
                <div>
                  <h2>Slack automations</h2>
                </div>
                <span className={`health-state ${slackState}`}>
                  {slackState === "ready"
                    ? "RUNNING"
                    : !slack
                      ? "NOT CHECKED"
                      : slackState === "neutral"
                        ? "NEVER RUN"
                        : "NEEDS ATTENTION"}
                </span>
              </div>
              {slack && (
                <div className="heartbeat-kid-grid">
                  <div className={slack.configured ? "ok" : "bad"}>
                    <b>{slack.configured ? "✓" : "!"}</b>
                    <span>
                      <strong>Slack token</strong>
                      <small>
                        {slack.configured
                          ? "Configured."
                          : "No Slack token is set, so nothing can post."}
                      </small>
                    </span>
                  </div>
                  <div className={slack.lastRunAt ? "ok" : "bad"}>
                    <b>{slack.lastRunAt ? "✓" : "!"}</b>
                    <span>
                      <strong>Last delivery</strong>
                      <small>
                        {slack.lastRunAt
                          ? `${formatStamp(slack.lastRunAt)} · ${formatAge(slack.lastRunAgeSeconds)}`
                          : "No brief has been delivered yet."}
                      </small>
                    </span>
                  </div>
                  <div className={slackFailing ? "bad" : "ok"}>
                    <b>{slackFailing ? "!" : "✓"}</b>
                    <span>
                      <strong>Deliveries</strong>
                      <small>
                        {slack.attempts} attempted · {slack.failures} failed
                        {slack.lastFailureAt
                          ? ` · last failed ${formatStamp(slack.lastFailureAt)}`
                          : ""}
                      </small>
                    </span>
                  </div>
                </div>
              )}
              {!slack ? (
                <p className="empty-state">
                  No Slack check was returned by the heartbeat.
                </p>
              ) : slack.error ? (
                <p className="error-text">{slack.error}</p>
              ) : slackRuns.length ? (
                <div className="slack-run-list">
                  {slackRuns.map((run) => (
                    <div
                      // Preview is tested before status, because a preview that "succeeded" still did
                      // not deliver anything and must not read as a green delivery.
                      className={`slack-run ${run.destination === "preview" ? "run-quiet" : run.status === "sent" ? "run-ok" : "run-bad"}`}
                      key={run.id}
                    >
                      <span className="slack-run-when">
                        {formatStamp(run.at)}
                      </span>
                      <span className="slack-run-client">{run.client}</span>
                      <span className="slack-run-where">
                        {destinationLabel(run.destination)}
                        {run.channelId ? ` · ${run.channelId}` : ""}
                      </span>
                      <span className="slack-run-status">
                        {run.destination === "preview"
                          ? "Preview"
                          : run.status === "sent"
                            ? "Sent"
                            : "Failed"}
                      </span>
                      {run.error && (
                        <span className="slack-run-error">{run.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-state">
                  No Slack automation has run yet.
                </p>
              )}
              {mode === "advanced" && (
                <details className="diagnostic-details" open>
                  <summary>Raw Slack automation log</summary>
                  <pre>{JSON.stringify(slack ?? null, null, 2)}</pre>
                </details>
              )}
            </section>

            <section className="admin-panel client-heartbeat-panel">
              <div className="panel-heading">
                <div>
                  <h2>Client connection heartbeat</h2>
                </div>
              </div>
              {clientCount === 0 ? (
                <p className="empty-state">
                  No client heartbeat data is available yet.
                </p>
              ) : (
                <div className="heartbeat-client-list">
                  {heartbeat.clients?.map((client) => {
                    const keyHealthy = client.keyConfigured;
                    const webhookHealthy =
                      client.webhookAgeSeconds !== null &&
                      client.webhookAgeSeconds <=
                        Number(
                          heartbeat.thresholds?.webhookFreshSeconds ?? 604800,
                        );
                    const pollHealthy =
                      client.pollAgeSeconds !== null &&
                      client.pollAgeSeconds <=
                        Number(heartbeat.thresholds?.pollFreshSeconds ?? 3600);
                    return (
                      <div className="heartbeat-client" key={client.slug}>
                        <div className="heartbeat-client-title">
                          <div className="heartbeat-client-name">
                            <i>
                              {client.logoUrl ? (
                                <img
                                  src={client.logoUrl}
                                  alt={`${client.name} logo`}
                                />
                              ) : (
                                client.name[0]
                              )}
                            </i>
                            <strong>{client.name}</strong>
                          </div>
                          <span
                            className={`health-state ${client.status === "healthy" ? "ready" : "missing"}`}
                          >
                            {client.status === "healthy"
                              ? "HEALTHY"
                              : client.status === "missing"
                                ? "NOT CONFIGURED"
                                : "NEEDS ATTENTION"}
                          </span>
                        </div>
                        <div className="heartbeat-kid-grid">
                          <div className={keyHealthy ? "ok" : "bad"}>
                            <b>{keyHealthy ? "✓" : "!"}</b>
                            <span>
                              <strong>Door key</strong>
                              <small>
                                {keyHealthy
                                  ? "HeyReach API key is ready."
                                  : "The HeyReach API key is missing."}
                              </small>
                            </span>
                          </div>
                          <div className={webhookHealthy ? "ok" : "bad"}>
                            <b>{webhookHealthy ? "✓" : "!"}</b>
                            <span>
                              <strong>Incoming replies</strong>
                              <small>
                                {client.webhookStatus ??
                                  formatAge(client.webhookAgeSeconds)}
                              </small>
                            </span>
                          </div>
                          <div className={pollHealthy ? "ok" : "bad"}>
                            <b>{pollHealthy ? "✓" : "!"}</b>
                            <span>
                              <strong>Background check</strong>
                              <small>
                                {client.pollStatus ??
                                  formatAge(client.pollAgeSeconds)}
                              </small>
                            </span>
                          </div>
                        </div>
                        {mode === "advanced" && (
                          <details className="diagnostic-details">
                            <summary>Technical details</summary>
                            <pre>
                              {JSON.stringify(
                                {
                                  ...client,
                                  lastWebhookReceivedAt: formatTime(
                                    client.lastWebhookReceivedAt,
                                  ),
                                  lastSuccessfulPollAt: formatTime(
                                    client.lastSuccessfulPollAt,
                                  ),
                                },
                                null,
                                2,
                              )}
                            </pre>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section
              className={`admin-panel granola-heartbeat-health ${granola?.state === "down" ? "has-alert" : ""}`}
            >
              <div className="panel-heading">
                <div>
                  <h2>Granola API heartbeat</h2>
                </div>
                <span className={`health-state ${granolaState}`}>
                  {granola?.state === "ok"
                    ? "RUNNING"
                    : granola?.state === "idle"
                      ? "PAUSED"
                      : granola?.state === "starting"
                        ? "STARTING"
                        : granola?.state === "down"
                          ? "DOWN"
                          : "NOT CHECKED"}
                </span>
              </div>
              {granola ? (
                <>
                  <div className="heartbeat-kid-grid">
                    <div className={granola.state === "down" ? "bad" : "ok"}>
                      <b>{granola.state === "down" ? "!" : granola.inWindow ? "✓" : "i"}</b>
                      <span>
                        <strong>Polling window</strong>
                        <small>
                          {granola.windowLabel} · {granola.pollIntervalLabel} ·{" "}
                          {granola.inWindow ? "open now" : "closed now"}
                        </small>
                      </span>
                    </div>
                    <div className={granola.state === "down" ? "bad" : "ok"}>
                      <b>{granola.state === "down" ? "!" : "✓"}</b>
                      <span>
                        <strong>Last poll</strong>
                        <small>
                          {granola.lastCheckedAt
                            ? `${formatStamp(granola.lastCheckedAt)} · ${formatAge(granola.lastCheckedAgeSeconds)}`
                            : "No poll has run yet."}
                        </small>
                      </span>
                    </div>
                    <div className="ok">
                      <b>i</b>
                      <span>
                        <strong>Calls found · last poll</strong>
                        <small>
                          {granola.callsFound} call(s) across {granola.clientsChecked}{" "}
                          client(s) · {granola.newCalls} new · {granola.keysSeen} key(s)
                        </small>
                      </span>
                    </div>
                  </div>
                  {granola.error && <p className="error-text">{granola.error}</p>}
                  {granola.clients && granola.clients.length ? (
                    <div className="slack-run-list">
                      {granola.clients.map((client) => (
                        <div
                          className={`slack-run ${client.isNew ? "run-ok" : "run-quiet"}`}
                          key={client.slug}
                        >
                          <span className="slack-run-client">{client.name}</span>
                          <span className="slack-run-where">
                            {client.title
                              ? `${client.title}${client.owner ? ` · via ${client.owner}` : ""}`
                              : "No matching call found"}
                          </span>
                          <span className="slack-run-status">
                            {client.startedAt ? formatStamp(new Date(client.startedAt).toISOString()) : "—"}
                          </span>
                          {client.isNew && <span className="slack-run-status">New</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-state">
                      {granola.inWindow
                        ? "The last poll found no matching calls."
                        : "Polling is paused until working hours."}
                    </p>
                  )}
                  {mode === "advanced" && (
                    <details className="diagnostic-details" open>
                      <summary>Granola heartbeat log — last twelve polls</summary>
                      <pre>{JSON.stringify(granola ?? null, null, 2)}</pre>
                    </details>
                  )}
                </>
              ) : (
                <p className="empty-state">
                  No Granola heartbeat was returned by the health check.
                </p>
              )}
            </section>
          </section>
        </main>
      </section>
    </div>
  );
}

function HealthCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn";
}) {
  return (
    <div className={`workspace-card health-summary-card summary-${tone}`}>
      <span className="health-summary-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
