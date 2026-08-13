"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import AppSidebar from "./AppSidebar";
import AppearancePanel, { type AppearancePrefs } from "./AppearancePanel";
import { useEffect, useState } from "react";
import {
  identityKey,
  readCachedAppearance,
  writeCachedAppearance,
} from "../lib/preference-identity";

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
type Summary = {
  repliesToday: number | null; repliesYesterday: number | null; repliesThisWeek: number | null;
  repliesThisMonth: number | null; repliesAllTime: number | null; clients: number | null;
  leads: number | null; monthLabel?: string;
};

const number = (value: number | null | undefined) => (value == null ? "—" : value.toLocaleString());

/**
 * A headline number with the period it covers and one line of context beneath it.
 *
 * The context line is the point: "12 replies" alone says nothing about whether that is a good day.
 */
function StatTile({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <article className="dashboard-stat-tile">
      <span className="dashboard-stat-label">{label}</span>
      <strong className="dashboard-stat-value" style={tone ? { color: tone } : undefined}>{value}</strong>
      <small className="dashboard-stat-hint">{hint}</small>
    </article>
  );
}

/** Reads the saved time zone so "today" means the reader's today, not the server's. */
const savedTimeZone = () =>
  String(readCachedAppearance()?.timeZone || defaultAppearance.timeZone);

export default function DashboardHome() {
  const [clients, setClients] = useState(initialClients);
  const [profiles, setProfiles] = useState<Array<{ name: string; description: string; tone: string; initials: string; slug: string; photo?: string | null }>>(initialProfiles.map(([name, description, tone, initials]) => ({ name, description, tone, initials, slug: name.toLowerCase().replaceAll(" ", "-") })));
  const [appearance, setAppearance] = useState<AppearancePrefs>(defaultAppearance);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    try {
      const savedClients = window.localStorage.getItem("reply-radar-workspaces:v2");
      if (savedClients) { /* eslint-disable-next-line react-hooks/set-state-in-effect */ setClients(JSON.parse(savedClients)); }
      const savedProfiles = window.localStorage.getItem("reply-radar-profiles:v2");
      if (savedProfiles) { /* eslint-disable-next-line react-hooks/set-state-in-effect */ setProfiles(JSON.parse(savedProfiles).map((profile: { name: string; clients?: string[]; color?: string; initials?: string; slug?: string; photo?: string | null }) => ({ ...profile, description: (profile.clients ?? []).join(" · "), tone: profile.color ?? "#8b7cff", initials: profile.initials ?? profile.name.slice(0, 2).toUpperCase(), slug: profile.slug ?? profile.name.toLowerCase().replaceAll(" ", "-"), photo: profile.photo ?? null }))); }
      const savedAppearance = readCachedAppearance();
      if (savedAppearance) setAppearance({ ...defaultAppearance, ...savedAppearance });
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
  useEffect(() => {
    fetch(`/api/analytics/summary?timeZone=${encodeURIComponent(savedTimeZone())}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => { if (payload?.ok) setSummary(payload as Summary); })
      .catch(() => undefined);
  }, []);
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
  // PreferenceBootstrap can restore a look off the server after this mounted; follow it so the
  // panel shows what is actually on screen.
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | Partial<AppearancePrefs>
        | undefined;
      if (detail) setAppearance((current) => ({ ...current, ...detail }));
    };
    window.addEventListener("reply-radar-appearance-changed", onChange);
    return () =>
      window.removeEventListener("reply-radar-appearance-changed", onChange);
  }, []);
  const saveAppearance = () => {
    writeCachedAppearance(appearance);
    void fetch("/api/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identity: identityKey(),
        scope: identityKey(),
        preferences: { appearance },
      }),
    }).catch(() => undefined);
    window.dispatchEvent(new CustomEvent("reply-radar-appearance-changed", { detail: appearance }));
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
          <section className="dashboard-stats-section">
            <div className="dashboard-stats-grid">
              <StatTile
                label="Replies today"
                value={number(summary?.repliesToday)}
                hint={
                  summary?.repliesToday == null || summary?.repliesYesterday == null
                    ? "Since midnight"
                    : summary.repliesToday === summary.repliesYesterday
                      ? "Same as yesterday"
                      : `${summary.repliesToday > summary.repliesYesterday ? "▲" : "▼"} ${Math.abs(summary.repliesToday - summary.repliesYesterday).toLocaleString()} vs yesterday`
                }
              />
              <StatTile label="Replies this week" value={number(summary?.repliesThisWeek)} hint="Since Monday" />
              <StatTile label="Replies this month" value={number(summary?.repliesThisMonth)} hint={summary?.monthLabel ?? "Calendar month"} />
              <StatTile label="All-time replies" value={number(summary?.repliesAllTime)} hint={summary?.leads == null ? "Every reply stored" : `Across ${summary.leads.toLocaleString()} leads`} />
              {/* Counted from the workspaces table rather than from the browser's saved copy, which can
                  lag behind a client someone else added. */}
              <StatTile
                label="Clients set up"
                value={number(summary?.clients ?? (clients.length || null))}
                hint={`${profiles.length} profile${profiles.length === 1 ? "" : "s"}`}
                tone="var(--accent)"
              />
            </div>
          </section>
          <section className="dashboard-clients-section">
            <div className="section-heading">
              <div>
                <h2>Client workspaces</h2>
              </div>
            </div>
            <div className="dashboard-client-grid">
              {[...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map((client) => (
                <a
                  href={`/inbox?client=${client.slug}`}
                  className="dashboard-client-card"
                  key={client.slug}
                >
                  <div className="dashboard-card-top">
                    <i style={client.logoUrl ? undefined : { background: client.tone }}>{client.logoUrl ? <img src={client.logoUrl} alt="" /> : client.name[0]}</i>
                  </div>
                  <h3>{client.name}</h3>
                </a>
              ))}
            </div>
          </section>
          <section className="dashboard-profiles-section">
            <div className="section-heading">
              <div>
                <h2>Profiles</h2>
              </div>
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
        </main>
      </section>
    </div>
  );
}
