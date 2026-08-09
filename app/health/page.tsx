"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";

type Service = { id: string; label: string; configured: boolean };
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
    recentFailures?: Array<{ startedAt?: string; workspaceId?: string; error?: string }>;
    recentRuns?: Array<Record<string, unknown>>;
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

export default function HealthPage() {
  const [mode, setMode] = useState<"basic" | "advanced">("basic");
  const [heartbeat, setHeartbeat] = useState<Heartbeat>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/heartbeat", { cache: "no-store" });
      setHeartbeat(response.ok ? await response.json() : { status: "error" });
    } catch {
      setHeartbeat({ status: "offline" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 30_000);
    return () => { window.clearTimeout(initialRefresh); window.clearInterval(timer); };
  }, [refresh]);

  const services = heartbeat.services ?? [];
  const aiArkHealthy = !heartbeat.aiArk || ["healthy", "disabled"].includes(heartbeat.aiArk.status);
  const clientCount = heartbeat.clients?.length ?? 0;
  const attentionCount = (heartbeat.clients ?? []).filter((client) => client.status !== "healthy").length;
  const healthy = heartbeat.status === "live" && services.every((service) => service.configured) && aiArkHealthy && heartbeat.worker?.status === "running" && attentionCount === 0;
  const lastChecked = useMemo(() => formatTime(heartbeat.checkedAt), [heartbeat.checkedAt]);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <div className="crumb"><span>Reply Radar</span><strong>› System health</strong></div>
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="admin-shell health-shell">
          <section className="admin-content">
            <div className="admin-heading">
              <div>
                <h1>System Health</h1>
              </div>
              <div className="health-actions">
                <div className="segmented-control" role="tablist" aria-label="Heartbeat detail level">
                  <button className={mode === "basic" ? "active" : ""} onClick={() => setMode("basic")}>Basic view</button>
                  <button className={mode === "advanced" ? "active" : ""} onClick={() => setMode("advanced")}>Advanced view</button>
                </div>
                <button className="primary-button" onClick={refresh} disabled={loading}>{loading ? "Checking…" : "Refresh checks ↻"}</button>
              </div>
            </div>

            <div className="workspace-cards heartbeat-summary">
              <HealthCard label="Overall check" value={healthy ? "Everything is healthy" : heartbeat.status === "offline" ? "Heartbeat unavailable" : "Some checks need attention"} tone={healthy ? "ok" : "warn"} />
              <HealthCard label="Clients checked" value={String(clientCount)} tone="ok" />
              <HealthCard label="Connections needing attention" value={String(attentionCount)} tone={attentionCount ? "warn" : "ok"} />
            </div>

            <section className="admin-panel heartbeat-explainer">
              <div className="panel-heading"><div><h2>What this means</h2><p>We check these connections automatically so you know when Reply Radar can do its job.</p></div></div>
              <div className="heartbeat-service-grid">
                {services.map((service) => <div className="heartbeat-service" key={service.id}><span className={`status-dot ${service.configured ? "ok" : "warn"}`} /><div><strong>{service.label}</strong><small>{service.configured ? "Connected and ready to use." : "Not connected yet. Add its configuration in Admin Console."}</small></div></div>)}
              </div>
            </section>

            <section className="admin-panel">
              <div className="panel-heading"><div><h2>Worker heartbeat</h2><p>The worker is the background helper that checks client connections and writes its results to Supabase.</p></div><span className={`health-state ${heartbeat.worker?.status === "running" ? "ready" : "missing"}`}>{heartbeat.worker?.status === "running" ? "RUNNING" : "WAITING"}</span></div>
              {heartbeat.worker ? <div className="heartbeat-log-list"><div><strong>Latest check</strong><span>{formatAge(heartbeat.worker.ageSeconds)} · {heartbeat.worker.workspacesSeen ?? 0} client(s) checked</span></div><div><strong>Started</strong><span>{formatTime(heartbeat.worker.startedAt)}</span></div><div><strong>Finished</strong><span>{formatTime(heartbeat.worker.finishedAt)}</span></div>{heartbeat.worker.error && <div><strong>Last error</strong><span className="error-text">{heartbeat.worker.error}</span></div>}</div> : <p className="empty-state">No worker check has been recorded yet. Deploy the Render worker and wait for its first cycle.</p>}
              {mode === "advanced" && heartbeat.worker && <details className="diagnostic-details" open><summary>Raw worker record</summary><pre>{JSON.stringify(heartbeat.worker.raw ?? heartbeat.worker, null, 2)}</pre></details>}
            </section>

            <section className={`admin-panel ai-ark-health ${heartbeat.aiArk?.status === "attention" || heartbeat.aiArk?.status === "not_configured" ? "has-alert" : ""}`}>
              <div className="panel-heading"><div><h2>AI Ark enrichment</h2><p>Checks real enrichment calls and recently stored LinkedIn leads for missing enriched data.</p></div><span className={`health-state ${heartbeat.aiArk?.status === "healthy" ? "ready" : heartbeat.aiArk?.status === "disabled" ? "neutral" : "missing"}`}>{heartbeat.aiArk?.status === "healthy" ? "HEALTHY" : heartbeat.aiArk?.status === "disabled" ? "DISABLED" : "NEEDS ATTENTION"}</span></div>
              <p className="ai-ark-health-explanation">{heartbeat.aiArk?.explanation ?? "Waiting for the first system check."}</p>
              <div className="heartbeat-kid-grid ai-ark-health-grid">
                <div className={heartbeat.aiArk?.configured || !heartbeat.aiArk?.enabled ? "ok" : "bad"}><b>{heartbeat.aiArk?.configured || !heartbeat.aiArk?.enabled ? "✓" : "!"}</b><span><strong>API connection</strong><small>{heartbeat.aiArk?.enabled ? heartbeat.aiArk?.configured ? "The AI Ark key is configured." : "The AI Ark key is missing." : "Calls are disabled globally."}</small></span></div>
                <div className={(heartbeat.aiArk?.failures24h ?? 0) > 5 ? "bad" : "ok"}><b>{(heartbeat.aiArk?.failures24h ?? 0) > 5 ? "!" : "✓"}</b><span><strong>API results · 24 hours</strong><small>{heartbeat.aiArk?.successes24h ?? 0} succeeded · {heartbeat.aiArk?.failures24h ?? 0} failed</small></span></div>
                <div className={(heartbeat.aiArk?.unenrichedLeads24h ?? 0) > 5 ? "bad" : "ok"}><b>{(heartbeat.aiArk?.unenrichedLeads24h ?? 0) > 5 ? "!" : "✓"}</b><span><strong>Stored lead check</strong><small>{heartbeat.aiArk?.unenrichedLeads24h ?? 0} recent LinkedIn lead(s) are missing enrichment.</small></span></div>
              </div>
              {mode === "advanced" && <details className="diagnostic-details" open><summary>AI Ark calls, failures, thresholds, and sanitized run records</summary><pre>{JSON.stringify(heartbeat.aiArk ?? null, null, 2)}</pre></details>}
            </section>

            <section className="admin-panel">
              <div className="panel-heading"><div><h2>Client connection heartbeat</h2><p>For each client, we check that its HeyReach key exists, webhook events are arriving, and polling is fresh.</p></div></div>
              {clientCount === 0 ? <p className="empty-state">No client heartbeat data is available yet.</p> : <div className="heartbeat-client-list">{heartbeat.clients?.map((client) => {
                const keyHealthy = client.keyConfigured;
                const webhookHealthy = client.webhookAgeSeconds !== null && client.webhookAgeSeconds <= Number(heartbeat.thresholds?.webhookFreshSeconds ?? 1800);
                const pollHealthy = client.pollAgeSeconds !== null && client.pollAgeSeconds <= Number(heartbeat.thresholds?.pollFreshSeconds ?? 3600);
                return <div className="heartbeat-client" key={client.slug}><div className="heartbeat-client-title"><div className="heartbeat-client-name"><i>{client.logoUrl ? <img src={client.logoUrl} alt={`${client.name} logo`} /> : client.name[0]}</i><strong>{client.name}</strong></div><span className={`health-state ${client.status === "healthy" ? "ready" : "missing"}`}>{client.status === "healthy" ? "HEALTHY" : client.status === "missing" ? "NOT CONFIGURED" : "NEEDS ATTENTION"}</span></div><div className="heartbeat-kid-grid"><div className={keyHealthy ? "ok" : "bad"}><b>{keyHealthy ? "✓" : "!"}</b><span><strong>Door key</strong><small>{keyHealthy ? "HeyReach API key is ready." : "The HeyReach API key is missing."}</small></span></div><div className={webhookHealthy ? "ok" : "bad"}><b>{webhookHealthy ? "✓" : "!"}</b><span><strong>Incoming replies</strong><small>{client.webhookStatus ?? formatAge(client.webhookAgeSeconds)}</small></span></div><div className={pollHealthy ? "ok" : "bad"}><b>{pollHealthy ? "✓" : "!"}</b><span><strong>Background check</strong><small>{client.pollStatus ?? formatAge(client.pollAgeSeconds)}</small></span></div></div>{mode === "advanced" && <details className="diagnostic-details"><summary>Technical details</summary><pre>{JSON.stringify({ ...client, lastWebhookReceivedAt: formatTime(client.lastWebhookReceivedAt), lastSuccessfulPollAt: formatTime(client.lastSuccessfulPollAt) }, null, 2)}</pre></details>}</div>;
              })}</div>}
            </section>

            <p className="heartbeat-last-checked">Last checked: {lastChecked} · Checks refresh automatically every 30 seconds.</p>
          </section>
        </main>
      </section>
    </div>
  );
}

function HealthCard({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" }) {
  return <div className="workspace-card"><div className="workspace-card-top"><span className={`health-state ${tone === "ok" ? "ready" : "missing"}`}>{tone === "ok" ? "HEALTHY" : "ACTION"}</span></div><strong>{value}</strong><small>{label}</small></div>;
}
