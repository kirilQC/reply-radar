"use client";

import { useState } from "react";
import AppSidebar from "./AppSidebar";

const clients = [
  {
    name: "Northstar AI",
    slug: "northstar",
    tone: "#8b7cff",
    leads: 486,
    replies: 6,
    status: "Connected",
  },
  {
    name: "Pylon Labs",
    slug: "pylon",
    tone: "#55c7a2",
    leads: 312,
    replies: 3,
    status: "Connected",
  },
  {
    name: "Vectorly",
    slug: "vectorly",
    tone: "#f2a36b",
    leads: 198,
    replies: 2,
    status: "Needs attention",
  },
];
const profiles = [
  [
    "Morning queue",
    "Hot and warm conversations across every active client",
    "12",
    "#8b7cff",
  ],
  [
    "Northstar revenue",
    "Pricing, meeting, and objection signals",
    "6",
    "#55c7a2",
  ],
  [
    "Re-engagement",
    "Threads that went quiet after a positive exchange",
    "8",
    "#f2a36b",
  ],
];

export default function DashboardHome() {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <div className="crumb">
            <strong>Reply Radar dashboard</strong>
          </div>
          <div className="top-actions">
            <button
              className="icon-button"
              onClick={() => setHelpOpen(true)}
              aria-label="Open help"
            >
              ?
            </button>
            <button className="icon-button theme-toggle">◐</button>
            <div className="top-avatar">AS</div>
          </div>
        </header>
        <main className="dashboard-home">
          <div className="dashboard-welcome">
            <div>
              <div className="eyebrow">
                <span className="live-dot" />
                AGENCY OVERVIEW
              </div>
              <h1>Good morning, Alex.</h1>
              <p>Choose a client or saved profile to start working.</p>
            </div>
            <a href="/admin" className="primary-button dashboard-admin-link">
              Open admin console
            </a>
          </div>
          <section>
            <div className="section-heading">
              <div>
                <h2>Client workspaces</h2>
                <p>Connection health and active conversation volume.</p>
              </div>
              <a href="/admin" className="text-button">
                Manage clients →
              </a>
            </div>
            <div className="dashboard-client-grid">
              {clients.map((client) => (
                <a
                  href={`/inbox?client=${client.slug}`}
                  className="dashboard-client-card"
                  key={client.slug}
                >
                  <div className="dashboard-card-top">
                    <i style={{ background: client.tone }}>{client.name[0]}</i>
                    <span
                      className={
                        client.status === "Connected"
                          ? "status-ok"
                          : "status-warn"
                      }
                    >
                      {client.status}
                    </span>
                  </div>
                  <h3>{client.name}</h3>
                  <p>
                    {client.leads} active leads · {client.replies} need action
                  </p>
                  <div className="dashboard-progress">
                    <span
                      style={{
                        width: `${Math.min(92, 48 + client.replies * 8)}%`,
                        background: client.tone,
                      }}
                    />
                  </div>
                  <strong>Open workspace →</strong>
                </a>
              ))}
            </div>
          </section>
          <section>
            <div className="section-heading">
              <div>
                <h2>Saved user profiles</h2>
                <p>Cross-client queues your team can open in one click.</p>
              </div>
              <a href="/profiles" className="text-button">
                View all profiles →
              </a>
            </div>
            <div className="dashboard-profile-grid">
              {profiles.map(([name, description, count, tone]) => (
                <a
                  href="/profiles"
                  className="dashboard-profile-card"
                  key={name}
                >
                  <i style={{ background: tone }}>✦</i>
                  <div>
                    <h3>{name}</h3>
                    <p>{description}</p>
                    <small>{count} conversations need action</small>
                  </div>
                  <span>→</span>
                </a>
              ))}
            </div>
          </section>
        </main>
        {helpOpen && (
          <div className="help-overlay" role="dialog" aria-modal="true">
            <div className="help-card">
              <button className="help-close" onClick={() => setHelpOpen(false)}>
                ×
              </button>
              <div className="eyebrow">
                <span className="live-dot" />
                REPLY RADAR HELP
              </div>
              <h2>How can we help?</h2>
              <p>
                Use the left rail to move between the dashboard, inbox,
                profiles, calendar, analytics, health, and admin configuration.
              </p>
              <a href="/health" className="primary-button">
                Check system health
              </a>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
