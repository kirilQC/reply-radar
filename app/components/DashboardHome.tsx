"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import AppSidebar from "./AppSidebar";
import AppearancePanel, { type AppearancePrefs } from "./AppearancePanel";
import { useEffect, useState } from "react";

const defaultAppearance: AppearancePrefs = {
  mode: "midnight",
  zoom: 100,
  font: "Inter, ui-sans-serif, system-ui, sans-serif",
  background: "#0b0c10",
  accent: "#8b7cff",
};

const seedClients = [
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
const seedProfiles = [
  ["Alex Spencer", "Northstar AI · Pylon Labs", "#8b7cff", "AS"],
  ["Jordan Lee", "Vectorly", "#55c7a2", "JL"],
  ["Maya Patel", "Northstar AI · Vectorly", "#f2a36b", "MP"],
];

export default function DashboardHome() {
  const [clients, setClients] = useState(seedClients);
  const [profiles, setProfiles] = useState(seedProfiles.map(([name, description, tone, initials]) => ({ name, description, tone, initials, slug: name.toLowerCase().replaceAll(" ", "-") })));
  const [appearance, setAppearance] = useState<AppearancePrefs>(defaultAppearance);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  useEffect(() => {
    try {
      const savedClients = window.localStorage.getItem("reply-radar-workspaces");
      if (savedClients) { /* eslint-disable-next-line react-hooks/set-state-in-effect */ setClients(JSON.parse(savedClients)); }
      const savedProfiles = window.localStorage.getItem("reply-radar-profiles");
      if (savedProfiles) { /* eslint-disable-next-line react-hooks/set-state-in-effect */ setProfiles(JSON.parse(savedProfiles).map((profile: { name: string; clients: string[]; color: string; initials: string; slug: string }) => ({ ...profile, description: profile.clients.join(" · "), tone: profile.color }))); }
      const savedPreferences = window.localStorage.getItem("reply-radar-prefs:general");
      if (savedPreferences) {
        const parsed = JSON.parse(savedPreferences);
        if (parsed.appearance) setAppearance({ ...defaultAppearance, ...parsed.appearance });
      }
    } catch { /* keep seed data */ }
  }, []);
  useEffect(() => {
    const refresh = () => {
      try {
        const savedClients = window.localStorage.getItem("reply-radar-workspaces");
        if (savedClients) setClients(JSON.parse(savedClients));
        const savedProfiles = window.localStorage.getItem("reply-radar-profiles");
        if (savedProfiles) setProfiles(JSON.parse(savedProfiles).map((profile: { name: string; clients: string[]; color: string; initials: string; slug: string }) => ({ ...profile, description: profile.clients.join(" · "), tone: profile.color })));
      } catch { /* keep current data */ }
    };
    window.addEventListener("reply-radar-workspaces-changed", refresh);
    window.addEventListener("reply-radar-profiles-changed", refresh);
    return () => { window.removeEventListener("reply-radar-workspaces-changed", refresh); window.removeEventListener("reply-radar-profiles-changed", refresh); };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent", appearance.accent);
    root.style.setProperty("--bg", appearance.background);
    root.style.setProperty("--font", appearance.font);
    root.style.setProperty("--reply-radar-zoom", `${appearance.zoom / 100}`);
    document.body.classList.toggle("light-mode", appearance.mode === "light");
  }, [appearance]);
  const saveAppearance = () => {
    const existing = JSON.parse(window.localStorage.getItem("reply-radar-prefs:general") || "{}");
    window.localStorage.setItem("reply-radar-prefs:general", JSON.stringify({ ...existing, appearance }));
    setAppearanceOpen(false);
  };
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <div className="crumb dashboard-brand">QC Growth</div>
          <div className="top-actions">
            <button className="icon-button theme-toggle" aria-label="Customize appearance" title="Customize appearance" onClick={() => setAppearanceOpen((open) => !open)}>◐</button>
            {appearanceOpen && <AppearancePanel prefs={appearance} onChange={setAppearance} onSave={saveAppearance} />}
          </div>
        </header>
        <main className="dashboard-home">
          <section>
            <div className="section-heading">
              <div>
                <h2>Client workspaces</h2>
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
                  </div>
                  <h3>{client.name}</h3>
                  <p>{client.leads} active leads</p>
                  <strong>Open workspace →</strong>
                </a>
              ))}
            </div>
          </section>
          <section>
            <div className="section-heading">
              <div>
                <h2>Profiles</h2>
              </div>
              <a href="/profiles" className="text-button">
                Manage profiles →
              </a>
            </div>
            <div className="dashboard-profile-grid">
              {profiles.map(({ name, description, tone, initials, slug }) => (
                <a
                  href={`/inbox?profile=${slug}`}
                  className="dashboard-profile-card"
                  key={name}
                >
                  <i style={{ background: tone }}>{initials}</i>
                  <div>
                    <h3>{name}</h3>
                    <p>{description}</p>
                  </div>
                  <span>→</span>
                </a>
              ))}
            </div>
          </section>
          <section className="dashboard-insights">
            <div className="section-heading">
              <div>
                <h2>Performance overview</h2>
              </div>
              <a href="/analytics" className="text-button">View full analytics →</a>
            </div>
            <div className="dashboard-chart-grid">
              <article className="dashboard-chart-card dashboard-line-card">
                <div className="dashboard-chart-heading"><div><span>REPLY VOLUME</span><strong>1,284 replies</strong></div><small>Last 7 days</small></div>
                <svg className="reply-line-chart" viewBox="0 0 520 170" role="img" aria-label="Reply volume trend over the last seven days">
                  <path className="chart-grid-line" d="M0 30H520M0 78H520M0 126H520" />
                  <path className="chart-area" d="M0 130 L74 112 L148 119 L222 74 L296 92 L370 48 L444 63 L520 22 L520 150 L0 150Z" />
                  <path className="chart-line" d="M0 130 L74 112 L148 119 L222 74 L296 92 L370 48 L444 63 L520 22" />
                  <circle cx="520" cy="22" r="4" className="chart-point" />
                </svg>
                <div className="chart-axis"><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span></div>
              </article>
              <article className="dashboard-chart-card">
                <div className="dashboard-chart-heading"><div><span>QUEUE MIX</span><strong>12 conversations</strong></div><small>Current</small></div>
                <div className="queue-mix-visual"><div className="donut-chart"><div><strong>12</strong><small>leads</small></div></div><div className="queue-legend"><span><i className="legend-hot"/>Hot <b>4</b></span><span><i className="legend-warm"/>Warm <b>3</b></span><span><i className="legend-nurture"/>Nurture <b>5</b></span></div></div>
              </article>
              <article className="dashboard-chart-card client-performance-card">
                <div className="dashboard-chart-heading"><div><span>CLIENT PERFORMANCE</span><strong>Positive reply rate</strong></div><small>30 days</small></div>
                {clients.map((client, index) => {
                  const values = ["72%", "64%", "51%", "—"];
                  const value = values[index] ?? "—";
                  return <div className="client-performance-row" key={client.slug}><div><span>{client.name}</span><b>{value}</b></div><div className="performance-track"><i style={{ width: value === "—" ? "0%" : value, background: client.tone }} /></div></div>;
                })}
              </article>
            </div>
          </section>
        </main>
      </section>
    </div>
  );
}
