"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";

type Service = { id: string; label: string; configured: boolean };
type Heartbeat = {
  status?: string;
  services?: Service[];
  checkedAt?: string;
  clients?: Array<{
    name: string;
    slug: string;
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
  const healthy = heartbeat.status === "live" && services.every((service) => service.configured);
  const clientCount = heartbeat.clients?.length ?? 0;
  const attentionCount = (heartbeat.clients ?? []).filter((client) => client.status !== "healthy").length;
  const lastChecked = useMemo(() => formatTime(heartbeat.checkedAt), [heartbeat.checkedAt]);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <div className="crumb"><span>Reply Radar</span><strong>› System health</strong></div>
        </header>
        <main className="admin-shell health-shell">
          <section className="admin-content">
            <div className="admin-heading">
              <div>
                <div className="eyebrow"><span className="live-dot" /> RELIABILITY MONITOR</div>
                <h1>Heartbeat</h1>
                <p>Live checks for the worker, database, AI provider, and every client connection.</p>
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

            <section className="admin-panel">
              <div className="panel-heading"><div><h2>Client connection heartbeat</h2><p>For each client, we check that its HeyReach key exists, webhook events are arriving, and polling is fresh.</p></div></div>
              {clientCount === 0 ? <p className="empty-state">No client heartbeat data is available yet.</p> : <div className="heartbeat-client-list">{heartbeat.clients?.map((client) => <div className="heartbeat-client" key={client.slug}><div className="heartbeat-client-title"><strong>{client.name}</strong><span className={`health-state ${client.status === "healthy" ? "ready" : "missing"}`}>{client.status === "healthy" ? "HEALTHY" : client.status === "missing" ? "NOT CONFIGURED" : "NEEDS ATTENTION"}</span></div><div className="heartbeat-client-meta"><span>API key: {client.keyConfigured ? "ready" : "missing"}</span><span>Webhook: {client.webhookStatus ?? formatAge(client.webhookAgeSeconds)}</span><span>Polling: {client.pollStatus ?? formatAge(client.pollAgeSeconds)}</span></div>{mode === "advanced" && <details className="diagnostic-details"><summary>Technical details</summary><pre>{JSON.stringify({ ...client, lastWebhookReceivedAt: formatTime(client.lastWebhookReceivedAt), lastSuccessfulPollAt: formatTime(client.lastSuccessfulPollAt) }, null, 2)}</pre></details>}</div>)}</div>}
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
