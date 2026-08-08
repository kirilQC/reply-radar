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
  timeZone: "America/New_York",
};

const initialClients: Array<{ name: string; slug: string; tone: string; leads: number; replies: number; status: string; logoUrl?: string }> = [];
const initialProfiles: string[][] = [];
type DashboardAnalytics = { totalReplies?: number; trend?: number[]; queueMix?: { hot: number; warm: number; nurture: number } };

export default function DashboardHome() {
  const [clients, setClients] = useState(initialClients);
  const [profiles, setProfiles] = useState<Array<{ name: string; description: string; tone: string; initials: string; slug: string; photo?: string | null }>>(initialProfiles.map(([name, description, tone, initials]) => ({ name, description, tone, initials, slug: name.toLowerCase().replaceAll(" ", "-") })));
  const [appearance, setAppearance] = useState<AppearancePrefs>(defaultAppearance);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [analytics, setAnalytics] = useState<DashboardAnalytics>({});
  useEffect(() => {
    try {
      const savedClients = window.localStorage.getItem("reply-radar-workspaces:v2");
      if (savedClients) { /* eslint-disable-next-line react-hooks/set-state-in-effect */ setClients(JSON.parse(savedClients)); }
      const savedProfiles = window.localStorage.getItem("reply-radar-profiles:v2");
      if (savedProfiles) { /* eslint-disable-next-line react-hooks/set-state-in-effect */ setProfiles(JSON.parse(savedProfiles).map((profile: { name: string; clients?: string[]; color?: string; initials?: string; slug?: string; photo?: string | null }) => ({ ...profile, description: (profile.clients ?? []).join(" · "), tone: profile.color ?? "#8b7cff", initials: profile.initials ?? profile.name.slice(0, 2).toUpperCase(), slug: profile.slug ?? profile.name.toLowerCase().replaceAll(" ", "-"), photo: profile.photo ?? null }))); }
      const savedPreferences = window.localStorage.getItem("reply-radar-prefs:general");
      if (savedPreferences) {
        const parsed = JSON.parse(savedPreferences);
        if (parsed.appearance) setAppearance({ ...defaultAppearance, ...parsed.appearance });
      }
    } catch { /* keep the empty state */ }
  }, []);
  const loadProfiles = () => fetch("/api/admin/profiles", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).then((payload) => {
    if (!payload?.profiles) return;
    setProfiles(payload.profiles.map((profile: { name: string; clients?: string[]; photo?: string | null; slug: string; color?: string }) => ({
      name: profile.name,
      description: (profile.clients ?? []).join(" · "),
      tone: profile.color ?? "#8b7cff",
      initials: profile.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
      slug: profile.slug,
      photo: profile.photo ?? null,
    })));
  }).catch(() => undefined);
  useEffect(() => { loadProfiles(); }, []);
  useEffect(() => { fetch("/api/analytics", { cache: "no-store" }).then((response) => response.json()).then(setAnalytics).catch(() => setAnalytics({})); }, []);
  useEffect(() => {
    const refresh = () => {
      try {
        const savedClients = window.localStorage.getItem("reply-radar-workspaces:v2");
        if (savedClients) setClients(JSON.parse(savedClients));
        const savedProfiles = window.localStorage.getItem("reply-radar-profiles:v2");
        if (savedProfiles) setProfiles(JSON.parse(savedProfiles).map((profile: { name: string; clients: string[]; color: string; initials: string; slug: string }) => ({ ...profile, description: profile.clients.join(" · "), tone: profile.color })));
        loadProfiles();
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
          <a className="crumb dashboard-brand" href="https://www.qcgrowth.com/" target="_blank" rel="noreferrer">QC Growth</a>
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
                    <i style={client.logoUrl ? undefined : { background: client.tone }}>{client.logoUrl ? <img src={client.logoUrl} alt="" /> : client.name[0]}</i>
                  </div>
                  <h3>{client.name}</h3>
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
              {profiles.map(({ name, description, tone, initials, slug, photo }) => (
                <a
                  href={`/inbox?profile=${slug}`}
                  className="dashboard-profile-card"
                  key={name}
                >
                  <i style={{ background: tone }}>{photo ? <img src={photo} alt="" /> : initials}</i>
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
                <div className="dashboard-chart-heading"><div><span>REPLY VOLUME</span><strong>{analytics.totalReplies == null ? "—" : `${analytics.totalReplies} replies`}</strong></div><small>Live data</small></div>
                {analytics.trend?.length ? <div className="dashboard-live-trend">{analytics.trend.map((value, index) => <i key={index} style={{ height: `${Math.max(4, value)}px` }} />)}</div> : <p className="empty-state">No synced analytics data is available yet.</p>}
              </article>
              <article className="dashboard-chart-card">
                <div className="dashboard-chart-heading"><div><span>QUEUE MIX</span><strong>Live conversations</strong></div><small>Current</small></div>
                <div className="queue-mix-visual"><div className="donut-chart"><div><strong>{analytics.queueMix ? analytics.queueMix.hot + analytics.queueMix.warm + analytics.queueMix.nurture : "—"}</strong><small>{analytics.queueMix ? "leads" : "no data"}</small></div></div><div className="queue-legend"><span><i className="legend-hot"/>Hot <b>{analytics.queueMix?.hot ?? "—"}</b></span><span><i className="legend-warm"/>Warm <b>{analytics.queueMix?.warm ?? "—"}</b></span><span><i className="legend-nurture"/>Nurture <b>{analytics.queueMix?.nurture ?? "—"}</b></span></div></div>
              </article>
              <article className="dashboard-chart-card client-performance-card">
                <div className="dashboard-chart-heading"><div><span>CLIENT PERFORMANCE</span><strong>Positive reply rate</strong></div><small>30 days</small></div>
                {clients.map((client) => {
                  const value = "—";
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
