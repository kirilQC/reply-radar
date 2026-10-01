// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import AppSidebar from "./AppSidebar";
import Crumb from "./Crumb";
import AppearancePanel, { type AppearancePrefs } from "./AppearancePanel";
import DashboardNetwork from "./DashboardNetwork";
import { useEffect, useRef, useState } from "react";
import {
  identityKey,
  readCachedAppearance,
  writeCachedAppearance,
} from "../lib/preference-identity";
import { accentOf, applyAccent, DEFAULT_ACCENT } from "../lib/brand-theme";

const defaultAppearance: AppearancePrefs = {
  mode: "midnight",
  zoom: 100,
  font: "Inter, ui-sans-serif, system-ui, sans-serif",
  background: "#0b0c10",
  accent: DEFAULT_ACCENT,
  timeZone: "America/New_York",
};

const initialClients: Array<{ name: string; slug: string; tone: string; leads: number; replies: number; status: string; logoUrl?: string }> = [];
const initialProfiles: string[][] = [];
type Summary = {
  repliesToday: number | null; repliesYesterday: number | null; repliesThisWeek: number | null;
  repliesThisMonth: number | null; repliesAllTime: number | null; clients: number | null;
  leads: number | null; monthLabel?: string;
};

/**
 * A number that counts to its value, and from its old value to a new one when the page refreshes the
 * figures, so a change is something you see happen rather than a digit that silently swaps.
 */
function CountUp({ value }: { value: number | null | undefined }) {
  const [shown, setShown] = useState<number | null>(value ?? null);
  const from = useRef(0);
  const [bumped, setBumped] = useState(false);
  useEffect(() => {
    if (value == null) return;
    const start = from.current;
    const end = value;
    if (start === end) { setShown(end); return; }
    if (start !== 0) { setBumped(true); window.setTimeout(() => setBumped(false), 900); }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(end); from.current = end; return; }
    const began = performance.now();
    const duration = start === 0 ? 1100 : 700;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      setShown(Math.round(start + (end - start) * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = end;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <span className={bumped ? "dash-bump" : undefined}>{shown == null ? "—" : shown.toLocaleString()}</span>;
}

/** "Good afternoon, Kiril · Wednesday, October 1 · 5:24 PM", kept live. Replaces the old wordmark. */
function Greeting({ name, timeZone }: { name: string; timeZone: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!now) return <div className="dash-greeting" aria-hidden />;
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(now)) % 24;
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const date = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone }).format(now);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(now);
  return (
    <div className="dash-greeting">
      <strong>{part}{name ? `, ${name.split(" ")[0]}` : ""}</strong>
      <span><i className="dash-live" aria-hidden />{date} · {time}</span>
    </div>
  );
}

/**
 * A headline number with the period it covers and one line of context beneath it.
 *
 * The context line is the point: "12 replies" alone says nothing about whether that is a good day.
 */
function StatTile({ label, value, hint, tone, index, live, trend }: { label: string; value: number | null | undefined; hint: string; tone?: string; index: number; live?: boolean; trend?: "up" | "down" }) {
  return (
    <article className="dashboard-stat-tile dash-in" style={{ ["--i" as string]: index }}>
      <span className="dashboard-stat-label">{label}{live && <i className="dash-live" title="Updates on its own" />}</span>
      <strong className="dashboard-stat-value" style={tone ? { color: tone } : undefined}><CountUp value={value} /></strong>
      <small className={`dashboard-stat-hint ${trend ? `dash-trend-${trend}` : ""}`}>{hint}</small>
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
      if (savedAppearance) setAppearance({ ...defaultAppearance, ...savedAppearance, accent: accentOf(savedAppearance) });
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
  // The figures refresh themselves every minute (and when the tab comes back into view), so the page
  // can be left open and still be right; CountUp animates each change.
  useEffect(() => {
    const load = () =>
      fetch(`/api/analytics/summary?timeZone=${encodeURIComponent(savedTimeZone())}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => { if (payload?.ok) setSummary(payload as Summary); })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  /** The spotlight that follows the pointer across any card. */
  const spotlight = (event: React.PointerEvent<HTMLElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".dashboard-stat-tile, .dashboard-profile-card, .dashboard-client-card");
    if (!card) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - box.left}px`);
    card.style.setProperty("--my", `${event.clientY - box.top}px`);
  };
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
    applyAccent(appearance.accent);
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
      if (detail) setAppearance((current) => ({ ...current, ...detail, accent: accentOf({ ...current, ...detail }) }));
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
      <section className="main-area dash-has-network">
        <DashboardNetwork />
        <header className="topbar">
          <Crumb trail={[{ label: "Dashboard" }]} />
          {/* The wordmark is centred over the bar rather than sitting in the trail, so the
              breadcrumb reads the same here as on every other page. */}
          <Greeting name="" timeZone={appearance.timeZone || defaultAppearance.timeZone} />
          <div className="top-actions">
            <button className="icon-button theme-toggle" data-popover-toggle aria-label="Customize appearance" title="Customize appearance" onClick={() => setAppearanceOpen((open) => !open)}>◐</button>
            {appearanceOpen && <AppearancePanel prefs={appearance} onChange={setAppearance} onSave={saveAppearance} />}
          </div>
        </header>
        <main className="dashboard-home" onPointerMove={spotlight}>
          <section className="dashboard-stats-section">
            <div className="dashboard-stats-grid">
              <StatTile
                index={0}
                live
                trend={summary?.repliesToday != null && summary?.repliesYesterday != null && summary.repliesToday !== summary.repliesYesterday ? (summary.repliesToday > summary.repliesYesterday ? "up" : "down") : undefined}
                label="Replies today"
                value={summary?.repliesToday}
                hint={
                  summary?.repliesToday == null || summary?.repliesYesterday == null
                    ? "Since midnight"
                    : summary.repliesToday === summary.repliesYesterday
                      ? "Same as yesterday"
                      : `${summary.repliesToday > summary.repliesYesterday ? "▲" : "▼"} ${Math.abs(summary.repliesToday - summary.repliesYesterday).toLocaleString()} vs yesterday`
                }
              />
              <StatTile index={1} label="Replies this week" value={summary?.repliesThisWeek} hint="Since Monday" />
              <StatTile index={2} label="Replies this month" value={summary?.repliesThisMonth} hint={summary?.monthLabel ?? "Calendar month"} />
              <StatTile index={3} label="All-time replies" value={summary?.repliesAllTime} hint={summary?.leads == null ? "Every reply stored" : `Across ${summary.leads.toLocaleString()} leads`} />
              {/* Counted from the workspaces table rather than from the browser's saved copy, which can
                  lag behind a client someone else added. */}
              <StatTile
                index={4}
                label="Clients set up"
                value={summary?.clients ?? (clients.length || null)}
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
              {[...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map((client, index) => (
                <a
                  href={`/inbox?client=${client.slug}`}
                  className="dashboard-client-card dash-in"
                  style={{ ["--i" as string]: Math.min(index, 16) + 8 }}
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
                <h2>Profiles {profiles.length > 0 && <span className="dash-count">{profiles.length}</span>}</h2>
              </div>
            </div>
            <div className="dashboard-profile-grid">
              {profiles.map(({ name, description, tone, initials, slug, photo }, index) => (
                <a
                  href={`/inbox?profile=${slug}`}
                  className="dashboard-profile-card dash-in"
                  style={{ ["--i" as string]: index + 5 }}
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
