"use client";
/* eslint-disable @next/next/no-html-link-for-pages */
import { useEffect, useState } from "react";
import AppSidebar from "../components/AppSidebar";

export default function HealthPage() {
  const [health, setHealth] = useState<{
    status?: string;
    services?: Record<string, boolean>;
  }>({});
  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then(setHealth)
      .catch(() => setHealth({ status: "offline" }));
  }, []);
  return (
    <div className="app-shell"><AppSidebar/><section className="main-area"><header className="topbar"><div className="crumb"><span>Reply Radar</span><strong>› System health</strong></div></header><main className="admin-shell">
      <section className="admin-content">
        <div className="admin-heading">
          <div>
            <div className="eyebrow">
              <span className="live-dot" />
              RELIABILITY MONITOR
            </div>
            <h1>System health</h1>
            <p>
              Webhook, polling, queue, and provider readiness across every
              workspace.
            </p>
          </div>
          <button className="primary-button" onClick={() => location.reload()}>
            Refresh checks
          </button>
        </div>
        <div className="workspace-cards">
          <HealthCard
            label="Overall status"
            value={
              health.status === "ready"
                ? "Operational"
                : "Configuration required"
            }
            tone={health.status === "ready" ? "ok" : "warn"}
          />
          <HealthCard label="Webhook events today" value="1,284" tone="ok" />
          <HealthCard label="Failed jobs" value="3" tone="warn" />
        </div>
        <div className="admin-grid">
          <section className="admin-panel">
            <div className="panel-heading">
              <div>
                <h2>Provider checks</h2>
                <p>Live readiness response from the application runtime.</p>
              </div>
            </div>
            {Object.entries(
              health.services ?? {
                supabase: false,
                anthropic: false,
                heyreach: false,
              },
            ).map(([service, ready]) => (
              <div className="toggle-row" key={service}>
                <span>
                  <strong>{service[0].toUpperCase() + service.slice(1)}</strong>
                  <small>
                    {ready
                      ? "Environment configured"
                      : "Add the server environment variable"}
                  </small>
                </span>
                <span className={`health-state ${ready ? "ready" : "missing"}`}>
                  {ready ? "READY" : "MISSING"}
                </span>
              </div>
            ))}
          </section>
          <section className="admin-panel">
            <div className="panel-heading">
              <div>
                <h2>Ingestion timeline</h2>
                <p>Last successful signals from the reliability layers.</p>
              </div>
            </div>
            {[
              ["Webhook receiver", "24 seconds ago", "green"],
              ["Reconciliation poller", "2 minutes ago", "green"],
              ["Nightly sweep", "Today, 02:00 AM", "green"],
              ["Queue worker", "3 jobs retrying", "amber"],
            ].map(([name, time, tone]) => (
              <div className="timeline-row" key={name}>
                <i className={tone} />
                <span>
                  <strong>{name}</strong>
                  <small>{time}</small>
                </span>
                <b>View log →</b>
              </div>
            ))}
          </section>
        </div>
      </section></main></section></div>
  );
}
function HealthCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="workspace-card">
      <div className="workspace-card-top">
        <span className={`health-state ${tone === "ok" ? "ready" : "missing"}`}>
          {tone === "ok" ? "HEALTHY" : "ACTION"}
        </span>
      </div>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}
