"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import DashboardHome from "./components/DashboardHome";
import AppSidebar from "./components/AppSidebar";
import AppearancePanel, { type AppearancePrefs } from "./components/AppearancePanel";

type Lead = {
  id: string;
  initials: string;
  name: string;
  role: string;
  company: string;
  client: string;
  clientSlug?: string;
  clientTone: string;
  score: number;
  tier: "hot" | "warm" | "nurture";
  reason: string;
  preview: string;
  age: string;
  replies: number;
  avatar: string;
  profileUrl?: string | null;
  photoUrl?: string | null;
  clientLogoUrl?: string | null;
  senderName: string;
  lastMessageAt?: string | null;
  messages: Array<{ id: string; body: string; direction: string; sentAt: string; authorName: string }>;
};
type LayoutPrefs = {
  order: Array<"metrics" | "analytics" | "queue">;
  showMetrics: boolean;
  showAnalytics: boolean;
  showDetail: boolean;
  compact: boolean;
  metrics: string[];
  graphs: GraphConfig[];
};
type GraphConfig = { id: string; title: string; metric: string; kind: "line" | "bars" | "donut" };
type AnalyticsSnapshot = {
  status: "live" | "no_data" | "not_configured" | "error";
  totalReplies: number;
  replies7d: number;
  trend: number[];
  queueMix: { hot: number; warm: number; nurture: number };
  clientLoad: Array<{ name: string; leads: number }>;
};
const defaultLayout: LayoutPrefs = {
  order: ["metrics", "analytics", "queue"],
  showMetrics: true,
  showAnalytics: true,
  showDetail: true,
  compact: false,
  metrics: ["needsAction", "hotConversations", "avgReplyTime", "pipelineSaved"],
  graphs: [
    { id: "reply-volume", title: "Reply volume", metric: "Replies · 7 days", kind: "line" },
    { id: "queue-mix", title: "Queue mix", metric: "Lead status", kind: "donut" },
  ],
};
const defaultAppearance: AppearancePrefs = {
  mode: "midnight",
  zoom: 100,
  font: "Inter, ui-sans-serif, system-ui, sans-serif",
  background: "#0b0c10",
  accent: "#8b7cff",
};
const metricCatalog = [
  { id: "needsAction", label: "Needs action", value: "—", delta: "", tone: "coral", sub: "Awaiting synced data" },
  { id: "hotConversations", label: "Hot conversations", value: "—", delta: "", tone: "purple", sub: "Awaiting synced data" },
  { id: "avgReplyTime", label: "Avg. reply time", value: "—", delta: "", tone: "green", sub: "Awaiting synced data" },
  { id: "pipelineSaved", label: "Follow-ups saved", value: "—", delta: "", tone: "amber", sub: "Awaiting synced data" },
  { id: "replyCount7d", label: "Replies · 7 days", value: "—", delta: "", tone: "purple", sub: "Awaiting synced data" },
  { id: "totalReplies", label: "Total replies", value: "—", delta: "", tone: "green", sub: "Awaiting synced data" },
  { id: "positiveRate", label: "Positive reply rate", value: "—", delta: "", tone: "green", sub: "Awaiting synced data" },
  { id: "avgRepliesCampaign", label: "Replies / campaign", value: "—", delta: "", tone: "coral", sub: "Awaiting synced data" },
];
const nav = [
  ["inbox", "General inbox", "⌘1"],
  ["profiles", "Profiles", "⌘2"],
  ["calendar", "Follow-up calendar", "⌘3"],
  ["analytics", "Analytics", "⌘4"],
  ["health", "System health", ""],
];
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    inbox: "M4 5h16v14H4z M4 9h5l1.5 2h3L15 9h5",
    profiles:
      "M16 20a4 4 0 0 0-8 0 M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M19 8v4m-2-2h4",
    calendar: "M5 4v3m14-3v3M4 9h16M6 6h12a2 2 0 0 1 2 2v10H4V8a2 2 0 0 1 2-2",
    analytics: "M5 19V9m5 10V5m5 14v-7m5 7V3",
    health: "M4 12h3l2-6 4 12 2-6h5",
    settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7",
    search: "m19 19-4-4m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    chevron: "m8 10 4 4 4-4",
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name] ?? paths.more} />
    </svg>
  );
}
export default function Home() {
  return <DashboardHome />;
}
export function InboxPage() {
  const router = useRouter();
  const [selected, setSelected] = useState(0),
    [activeNav, setActiveNav] = useState("inbox"),
    [filter, setFilter] = useState("All follow-ups"),
    [sort, setSort] = useState("score-desc"),
    [search, setSearch] = useState(""),
    [theme, setTheme] = useState("midnight"),
    [sent, setSent] = useState(false),
    [sidebarOpen, setSidebarOpen] = useState(false);
  const [layoutPrefs, setLayoutPrefs] = useState(defaultLayout);
  const [appearance, setAppearance] = useState(defaultAppearance);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [inboxError, setInboxError] = useState("");
  const [queryString, setQueryString] = useState("");
  const [workspaceDirectory, setWorkspaceDirectory] = useState<Array<{ name: string; slug: string; tone?: string; logoUrl?: string }>>([]);
  const [liveProfiles, setLiveProfiles] = useState<Array<{ slug: string; name: string; clients: string[] }>>([]);
  useEffect(() => {
    // URL search params are client-only state on this static route.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueryString(window.location.search);
    const refreshWorkspaces = () => {
      try {
        const saved = window.localStorage.getItem("reply-radar-workspaces:v2");
        if (saved) setWorkspaceDirectory(JSON.parse(saved));
        const savedProfiles = window.localStorage.getItem("reply-radar-profiles:v2");
        if (savedProfiles) setLiveProfiles(JSON.parse(savedProfiles));
      } catch { /* keep the empty live state */ }
    };
    refreshWorkspaces();
    window.addEventListener("reply-radar-workspaces-changed", refreshWorkspaces);
    window.addEventListener("reply-radar-profiles-changed", refreshWorkspaces);
    window.addEventListener("storage", refreshWorkspaces);
    return () => { window.removeEventListener("reply-radar-workspaces-changed", refreshWorkspaces); window.removeEventListener("reply-radar-profiles-changed", refreshWorkspaces); window.removeEventListener("storage", refreshWorkspaces); };
  }, []);
  useEffect(() => {
    if (new URLSearchParams(queryString).get("appearance") === "1") setAppearanceOpen(true);
  }, [queryString]);
  const query = new URLSearchParams(queryString);
  const clientParam = query.get("client");
  const profileParam = query.get("profile");
  const liveProfile = liveProfiles.find((profile) => profile.slug === profileParam);
  const clientLabel = (name: string) => {
    const workspace = workspaceDirectory.find((item) => item.name === name);
    return workspace?.name || name;
  };
  const assignedClients = liveProfile
      ? liveProfile.clients.map(clientLabel)
        : clientParam
          ? [workspaceDirectory.find((item) => item.slug === clientParam)?.name || clientParam]
          : null;
  const profileName = liveProfile?.name ?? null;
  const allWorkspaceNames = workspaceDirectory.map((item) => item.name).filter(Boolean);
  const trackedClients = assignedClients ?? allWorkspaceNames;
  const trackedWorkspaceSlugs = trackedClients.map((client) => workspaceDirectory.find((item) => item.name === client)?.slug || client.toLowerCase());
  const greeting =
    new Date().getHours() < 12
      ? "Good morning"
      : new Date().getHours() < 18
        ? "Good afternoon"
        : "Good evening";
  const todayLabel = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "2-digit" }).format(new Date()).toUpperCase();
  const activeWorkspace = clientParam ? workspaceDirectory.find((item) => item.slug === clientParam) : undefined;
  const clientName = activeWorkspace?.name || clientParam || "All clients";
  const clientTone = activeWorkspace?.tone || "var(--accent)";
  const clientLogo = activeWorkspace?.logoUrl || "";
  useEffect(() => {
    if (!clientParam) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue("--accent");
    root.style.setProperty("--accent", clientTone);
    return () => {
      if (previous) root.style.setProperty("--accent", previous);
      else root.style.removeProperty("--accent");
    };
  }, [clientParam, clientTone]);
  const preferenceScope = profileParam || "general";
  const preferenceKey = `reply-radar-prefs:${preferenceScope}`;
  useEffect(() => {
      const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(preferenceKey);
        const fallback = window.localStorage.getItem("reply-radar-prefs:general");
        const cookieValue = document.cookie
          .split("; ")
          .find((item) => item.startsWith("reply-radar-preferences="))
          ?.split("=")[1];
        const parsed = JSON.parse(saved || fallback || (cookieValue ? decodeURIComponent(cookieValue) : "null"));
        if (parsed?.layout) {
          const nextLayout = { ...defaultLayout, ...parsed.layout };
          nextLayout.order = Array.from(new Set([...nextLayout.order, "metrics", "analytics", "queue"])).filter((item) => ["metrics", "analytics", "queue"].includes(item)) as LayoutPrefs["order"];
          setLayoutPrefs(nextLayout);
        }
        if (parsed?.appearance) {
          const nextAppearance = { ...defaultAppearance, ...parsed.appearance };
          setAppearance(nextAppearance);
          setTheme(nextAppearance.mode);
        }
      } catch {
        // Keep defaults if a saved preference cannot be read.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [preferenceKey]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/analytics?workspaces=${trackedWorkspaceSlugs.join(",")}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: AnalyticsSnapshot) => { if (!cancelled) setAnalytics(payload); })
      .catch(() => { if (!cancelled) setAnalytics({ status: "error", totalReplies: 0, replies7d: 0, trend: [], queueMix: { hot: 0, warm: 0, nurture: 0 }, clientLoad: [] }); });
    return () => { cancelled = true; };
  }, [trackedClients.join(",")]);
  useEffect(() => {
    let cancelled = false;
    setInboxLoading(true);
    setInboxError("");
    fetch(`/api/inbox?workspaces=${encodeURIComponent(trackedWorkspaceSlugs.join(","))}`, { cache: "no-store" })
      .then(async (response) => ({ response, payload: await response.json().catch(() => ({})) }))
      .then(({ response, payload }) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(String(payload.error ?? "Inbox could not be loaded."));
        setLeads(Array.isArray(payload.conversations) ? payload.conversations : []);
      })
      .catch((error) => { if (!cancelled) { setLeads([]); setInboxError(error instanceof Error ? error.message : "Inbox could not be loaded."); } })
      .finally(() => { if (!cancelled) setInboxLoading(false); });
    return () => { cancelled = true; };
  }, [trackedWorkspaceSlugs.join(",")]);
  const savePreferences = (nextLayout = layoutPrefs, nextAppearance = appearance) => {
    const payload = { layout: nextLayout, appearance: nextAppearance };
    window.localStorage.setItem(preferenceKey, JSON.stringify(payload));
    // Also retain the device-level fallback for the general inbox.
    window.localStorage.setItem("reply-radar-prefs:general", JSON.stringify(payload));
    // Apply the same settings to the document immediately so they remain global
    // while navigating between routes (not just on the inbox's local <main>).
    const root = document.documentElement;
    root.style.setProperty("--accent", nextAppearance.accent);
    root.style.setProperty("--bg", nextAppearance.background);
    root.style.setProperty("--font", nextAppearance.font);
    root.style.setProperty("--reply-radar-zoom", `${nextAppearance.zoom / 100}`);
    document.body.classList.toggle("light-mode", nextAppearance.mode === "light");
    void fetch("/api/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: preferenceScope, preferences: payload }),
    }).catch(() => undefined);
  };
  useEffect(() => {
    if (activeNav !== "inbox") router.push(`/${activeNav}`);
  }, [activeNav, router]);
  useEffect(() => {
    const toast = (message: string) => {
      let node = document.querySelector<HTMLDivElement>(
        "[data-reply-radar-toast]",
      );
      if (!node) {
        node = document.createElement("div");
        node.dataset.replyRadarToast = "true";
        node.style.cssText =
          "position:fixed;right:24px;bottom:24px;z-index:50;padding:12px 16px;border:1px solid #383d50;border-radius:10px;background:#171a24;color:#f5f6fb;box-shadow:0 12px 30px #0008;font-size:13px";
        document.body.appendChild(node);
      }
      node.textContent = message;
      node.style.opacity = "1";
      window.setTimeout(() => {
        if (node) node.style.opacity = "0";
      }, 2400);
    };
    const workspace =
      document.querySelector<HTMLButtonElement>(".workspace-select");
    const clientButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".client-list button"),
    );
    const exportButton = document.querySelector<HTMLButtonElement>(
      ".heading-actions .secondary-button",
    );
    const addButton = document.querySelector<HTMLButtonElement>(
      ".heading-actions .primary-button",
    );
    const workspaceHandler = () => {
      const name = window.prompt("Switch workspace", "All client workspaces");
      const label = workspace?.querySelector("strong");
      if (name && label) label.textContent = name;
      if (name) toast(`Switched to ${name}`);
    };
    const clientHandlers = clientButtons.map((button) => {
      const handler = () => {
        const name = button.textContent?.replace(/\d+$/, "").trim() || "client";
        const label = workspace?.querySelector("strong");
        if (label) label.textContent = name;
        toast(`Switched to ${name} workspace`);
      };
      button.addEventListener("click", handler);
      return [button, handler] as const;
    });
    const exportHandler = () => {
      const csv = [
        "Lead,Client,Score,Tier",
        ...leads.map(
          (lead) => `${lead.name},${lead.client},${lead.score},${lead.tier}`,
        ),
      ].join("\n");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      link.download = "reply-radar-follow-ups.csv";
      link.click();
      URL.revokeObjectURL(link.href);
      toast("Follow-up queue exported.");
    };
    const addHandler = () => {
      const name = window.prompt(
        "Who should receive this follow-up?",
        "New lead",
      );
      if (name) toast(`Follow-up draft created for ${name}.`);
    };
    workspace?.addEventListener("click", workspaceHandler);
    exportButton?.addEventListener("click", exportHandler);
    addButton?.addEventListener("click", addHandler);
    return () => {
      workspace?.removeEventListener("click", workspaceHandler);
      clientHandlers.forEach(([button, handler]) =>
        button.removeEventListener("click", handler),
      );
      exportButton?.removeEventListener("click", exportHandler);
      addButton?.removeEventListener("click", addHandler);
    };
  }, [leads]);
  const filtered = useMemo(
    () =>
      leads.filter(
        (lead) =>
          (!search ||
            `${lead.name} ${lead.company} ${lead.client}`
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (!assignedClients || assignedClients.includes(lead.client)) &&
          (filter === "All follow-ups" || lead.tier === filter.toLowerCase()),
      ).sort((a, b) => sort === "newest" ? new Date(String(b.lastMessageAt)).getTime() - new Date(String(a.lastMessageAt)).getTime() : sort === "oldest" ? new Date(String(a.lastMessageAt)).getTime() - new Date(String(b.lastMessageAt)).getTime() : sort === "name" ? a.name.localeCompare(b.name) : b.score - a.score),
    [leads, search, filter, sort, assignedClients],
  );
  const current: Lead = filtered[selected] ?? {
    id: "empty",
    initials: "?",
    name: "No conversation selected",
    role: "",
    company: "",
    client: "",
    senderName: "Unknown sender",
    clientTone: "var(--accent)",
    score: 0,
    tier: "nurture",
    reason: "Connect a data source to load conversation details.",
    preview: "",
    age: "",
    replies: 0,
    avatar: "var(--panel-2)",
    messages: [],
  };
  const clientLogoFor = (lead: Lead) => lead.clientLogoUrl || workspaceDirectory.find((workspace) => workspace.slug === lead.clientSlug || workspace.name === lead.client)?.logoUrl || null;
  return (
    <main
      className={`app-shell ${theme === "light" ? "light-mode" : ""} ${layoutPrefs.compact ? "compact-inbox" : ""}`}
      style={{
        "--accent": appearance.accent,
        "--bg": appearance.background,
        "--font": appearance.font,
        fontFamily: appearance.font,
      } as React.CSSProperties}
    >
      <AppSidebar />
      <aside
        className={`sidebar legacy-sidebar ${sidebarOpen ? "sidebar-open" : ""}`}
      >
        <div className="brand-row">
          <div className="brand-mark">
            <span />
            <span />
            <span />
          </div>
          <div className="brand-name">
            reply<span>radar</span>
          </div>
          <button
            className="mobile-close"
            onClick={() => setSidebarOpen(false)}
          >
            ×
          </button>
        </div>
        <button className="workspace-select">
          <span className="workspace-dot" />
          <span>
            <small>WORKSPACE</small>
            <strong>All client workspaces</strong>
          </span>
          <Icon name="chevron" />
        </button>
        <div className="nav-label">Operate</div>
        <nav>
          {nav.map(([id, label, shortcut]) => (
            <button
              key={id}
              className={`nav-item ${activeNav === id ? "active" : ""}`}
              onClick={() => {
                setActiveNav(id);
                setSidebarOpen(false);
              }}
            >
              <Icon name={id} />
              <span>{label}</span>
              {id === "inbox" && <b className="nav-count">12</b>}
              {shortcut && <kbd>{shortcut}</kbd>}
            </button>
          ))}
        </nav>
        <div className="nav-label clients-label">
          Clients <button>+</button>
        </div>
        <div className="client-list">
          {workspaceDirectory.map((workspace) => (
            <a
              href={`/inbox?client=${workspace.slug}`}
              className={`client-directory-item ${clientParam === workspace.slug ? "selected" : ""}`}
              key={workspace.slug}
            >
              <i style={{ background: workspace.tone ?? "var(--accent)" }}>{workspace.name?.[0] ?? "?"}</i>
              {workspace.name || "Unnamed client"}
            </a>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item">
            <Icon name="settings" />
            <span>Admin console</span>
          </button>
          <div className="user-chip">
            <div className="user-avatar">?</div>
            <div>
              <strong>Profile not selected</strong>
              <small>Select a profile to personalize this view</small>
            </div>
            <Icon name="more" />
          </div>
        </div>
      </aside>
      <section className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setSidebarOpen(true)}>
            ☰
          </button>
          <div className="crumb">
            <span>Reply Radar</span>
            <Icon name="chevron" />
            <strong>
              {profileName ?? (clientParam ? clientName : "General inbox")}
            </strong>
          </div>
          <div className="top-actions">
            <button
              className="icon-button layout-button"
              aria-label="Customize inbox layout"
              title="Customize inbox layout"
              onClick={() => {
                setLayoutOpen((open) => !open);
                setAppearanceOpen(false);
              }}
            >
              ⚙
            </button>
            <button
              className="icon-button theme-toggle"
              aria-label="Customize appearance"
              title="Customize appearance"
              onClick={() => {
                setAppearanceOpen((open) => !open);
                setLayoutOpen(false);
              }}
            >
              ◐
            </button>
            {layoutOpen && (
              <LayoutPanel
                prefs={layoutPrefs}
                onChange={setLayoutPrefs}
                onSave={() => {
                  savePreferences(layoutPrefs, appearance);
                  setLayoutOpen(false);
                }}
              />
            )}
            {appearanceOpen && (
              <AppearancePanel
                prefs={appearance}
                onChange={(next) => {
                  setAppearance(next);
                  setTheme(next.mode);
                }}
                onSave={() => {
                  savePreferences(layoutPrefs, appearance);
                  setAppearanceOpen(false);
                }}
              />
            )}
          </div>
        </header>
        <div className="content-wrap">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="live-dot" />
                LIVE QUEUE <span className="eyebrow-separator">/</span> {todayLabel}
              </div>
              <h1>
                {clientParam && <span className="inbox-heading-logo" style={{ background: clientTone }}>{clientLogo ? <img src={clientLogo} alt="" /> : clientName[0]}</span>}
                {profileName ? `${greeting}, ${profileName}` : clientParam ? clientName : "General inbox"}
              </h1>
              {!clientParam && <><p>{filtered.length} leads across {trackedClients.length} clients</p><div className="tracked-clients">{trackedClients.map((client) => <span key={client}>{client}</span>)}</div></>}
            </div>
          </div>
          <div className="inbox-layout">
          <div className="layout-section metrics metrics-section" style={{ order: layoutPrefs.order.indexOf("metrics"), "--metric-count": layoutPrefs.metrics.length } as React.CSSProperties} hidden={!layoutPrefs.showMetrics}>
            {layoutPrefs.metrics.map((metricId) => {
              const metric = metricCatalog.find((item) => item.id === metricId);
              return metric ? <Metric key={metric.id} {...metric} /> : null;
            })}
          </div>
          <div className="layout-section" style={{ order: layoutPrefs.order.indexOf("analytics") }} hidden={!layoutPrefs.showAnalytics}>
            <InboxAnalytics graphs={layoutPrefs.graphs} analytics={analytics} onChange={(graphs) => setLayoutPrefs({ ...layoutPrefs, graphs })} />
          </div>
          <div className="layout-section queue-section" style={{ order: layoutPrefs.order.indexOf("queue") }}>
          <div className="health-strip">
            <div className="health-icon">
              <Icon name="health" />
            </div>
            <div>
              <strong>Waiting for synced events</strong>
              <span>Connect a data source to populate system activity.</span>
            </div>
            <div className="health-bars">
              {(analytics?.trend ?? []).map((h, i) => (
                <i key={i} style={{ height: `${Math.max(2, h)}px` }} />
              ))}
            </div>
            <button
              className="text-button"
              onClick={() => setActiveNav("health")}
            >
              View health <Icon name="arrow" />
            </button>
          </div>
          <div className="queue-header">
            <div>
              <h2>
                Reply queue {filtered.length > 0 && <span>{filtered.length}</span>}
              </h2>
              <p>Ranked by urgency and conversation intent</p>
            </div>
            <div className="queue-tools">
              <label className="search queue-search">
                <Icon name="search" />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search leads, companies…" />
              </label>
              <div className="heading-actions inbox-actions">
                <button className="secondary-button">
                  Export <span>↓</span>
                </button>
                <button className="primary-button">+ Add follow-up</button>
              </div>
              <div className="segmented">
                {["All follow-ups", "Hot", "Warm", "Nurture"].map((f) => (
                  <button
                    key={f}
                    className={filter === f ? "selected" : ""}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                    {f === "Hot" && analytics?.queueMix?.hot ? <b>{analytics.queueMix.hot}</b> : null}
                  </button>
                ))}
              </div>
              <select className="filter-button" aria-label="Filter conversations" value={filter} onChange={(event) => { setFilter(event.target.value); setSelected(0); }}><option>All follow-ups</option><option>Hot</option><option>Warm</option><option>Nurture</option></select>
              <select className="filter-button" aria-label="Sort conversations" value={sort} onChange={(event) => { setSort(event.target.value); setSelected(0); }}><option value="score-desc">Sort: Score</option><option value="newest">Sort: Newest</option><option value="oldest">Sort: Oldest</option><option value="name">Sort: Name</option></select>
            </div>
          </div>
          <div className="dashboard-grid">
            <section className="queue-card">
              <div className="table-head">
                <span>LEAD</span>
                <span>CLIENT</span>
                <span>URGENCY</span>
                <span>LAST MESSAGE</span>
                <span />
              </div>
              {inboxLoading && <p className="empty-state">Loading conversations…</p>}
              {!inboxLoading && inboxError && <p className="empty-state error-text">{inboxError}</p>}
              {!inboxLoading && !inboxError && filtered.length === 0 && <p className="empty-state">No conversations have arrived for this inbox yet.</p>}
              {filtered.map((lead, index) => (
                <button
                  className={`lead-row ${selected === index ? "row-selected" : ""}`}
                  key={lead.id}
                  onClick={() => setSelected(index)}
                >
                  <div className="lead-main">
                    <div
                      className="lead-avatar"
                      style={{ background: lead.avatar }}
                    >
                      {lead.photoUrl ? <img src={lead.photoUrl} alt="" /> : lead.initials}
                    </div>
                    <div>
                      <strong>{lead.name}</strong>
                      <span>
                        {lead.role} · {lead.company}
                      </span>
                    </div>
                  </div>
                  <div className="client-cell">
                    <i style={{ background: lead.clientTone }}>
                      {clientLogoFor(lead) ? <img src={String(clientLogoFor(lead))} alt="" /> : lead.client[0]}
                    </i>
                    <span>{lead.client}</span>
                  </div>
                  <div className="score-cell">
                    <span className={`score-pill ${lead.tier}`}>
                      {lead.score}
                    </span>
                    <span className="tier-label">{lead.tier}</span>
                  </div>
                  <div className="message-cell">
                    <span>{lead.preview}</span>
                    <small>
                      {lead.age} · {lead.replies} replies
                    </small>
                  </div>
                  <div className="row-more">
                    <Icon name="more" />
                  </div>
                </button>
              ))}
              <div className="queue-footer">
                <span>Showing {filtered.length} conversations</span>
                <button>
                  View all <Icon name="arrow" />
                </button>
              </div>
            </section>
            <aside className={`detail-card ${layoutPrefs.showDetail ? "" : "layout-hidden"}`}>
              <div className="detail-top">
                <div className="detail-context">
                  <span className="detail-label">SELECTED CONVERSATION</span>
                  <button>
                    <Icon name="more" />
                  </button>
                </div>
                <div className="detail-person">
                  <div
                    className="large-avatar"
                    style={{ background: current.avatar }}
                  >
                    {current.photoUrl ? <img src={current.photoUrl} alt="" /> : current.initials}
                  </div>
                  <div>
                    <h3>{current.name}</h3>
                    <p>
                      {current.role} at {current.company}
                    </p>
                    {current.profileUrl && <a className="linkedin" href={current.profileUrl} target="_blank" rel="noreferrer">in&nbsp; LinkedIn profile ↗</a>}
                  </div>
                </div>
                <div className="detail-tags">
                  <span className={`score-pill ${current.tier}`}>
                    {current.score} · {current.tier}
                  </span>
                  <span className="tag-outline">{current.client}</span>
                  <span className="tag-outline">Sender: {current.senderName}</span>
                  <span className="tag-outline">{current.replies} replies</span>
                </div>
              </div>
              <div className="reason-box">
                <span className="reason-icon">✦</span>
                <div>
                  <small>WHY THIS IS FLAGGED</small>
                  <p>{current.reason}</p>
                </div>
              </div>
              <div className="thread">
                {current.messages.length ? current.messages.map((message) => <div className={`bubble ${message.direction === "outbound" ? "outbound" : "inbound"}`} key={message.id}>{message.direction !== "outbound" && <span>{current.initials}</span>}<small className="message-author">{message.authorName}</small><p>{message.body}</p><time>{new Date(message.sentAt).toLocaleString()}</time></div>) : <p className="empty-state">No conversation messages are available yet.</p>}
              </div>
              <div className="composer">
                <div className="composer-top">
                  <span>AI DRAFT</span>
                  <button>Regenerate ↻</button>
                </div>
                <textarea
                  defaultValue={
                    sent
                      ? "Sent — follow-up queued in HeyReach."
                      : ""
                  }
                />
                <div className="composer-foot">
                  <span>{sent ? "Follow-up queued" : ""}</span>
                  <button className="send-button" onClick={() => setSent(true)}>
                    {sent ? "Sent ✓" : "Send reply"} <span>⌘↵</span>
                  </button>
                </div>
              </div>
            </aside>
          </div>
          </div>
          </div>
        </div>
      </section>
    </main>
  );
}
function Metric({
  label,
  value,
  delta,
  tone,
  sub,
}: {
  label: string;
  value: string;
  delta: string;
  tone: string;
  sub: string;
}) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`} />
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{delta}</em>
      <small>{sub}</small>
    </div>
  );
}

const graphPresets: Array<Omit<GraphConfig, "id">> = [
  { title: "Reply volume", metric: "Replies · 7 days", kind: "line" },
  { title: "Queue mix", metric: "Lead status", kind: "donut" },
  { title: "Positive reply rate", metric: "Positive replies", kind: "bars" },
  { title: "Response speed", metric: "Avg. reply time", kind: "line" },
  { title: "Client load", metric: "Leads by client", kind: "bars" },
];

function InboxAnalytics({
  graphs,
  analytics,
  onChange,
}: {
  graphs: GraphConfig[];
  analytics: AnalyticsSnapshot | null;
  onChange: (graphs: GraphConfig[]) => void;
}) {
  const [newPreset, setNewPreset] = useState(2);
  const [newKind, setNewKind] = useState<GraphConfig["kind"]>("line");
  const [newTitle, setNewTitle] = useState("");
  const addGraph = () => {
    if (graphs.length >= 4) return;
    const preset = graphPresets[newPreset];
    onChange([
      ...graphs,
      {
        ...preset,
        id: `custom-${Date.now()}`,
        title: newTitle.trim() || preset.title,
        kind: newKind,
      },
    ]);
    setNewTitle("");
  };
  return (
    <section className="inbox-analytics-section">
      <div className="inbox-analytics-heading">
        <div><span>INBOX ANALYTICS</span><h2>Conversation trends</h2><p>{analytics?.status === "live" ? "Live aggregates from synced conversations and messages." : "Analytics will populate after Supabase receives synced HeyReach data."}</p></div>
        <div className="graph-builder"><select value={newPreset} onChange={(event) => setNewPreset(Number(event.target.value))}>{graphPresets.map((preset, index) => <option key={preset.title} value={index}>{preset.title}</option>)}</select><select value={newKind} onChange={(event) => setNewKind(event.target.value as GraphConfig["kind"])}><option value="line">Line</option><option value="bars">Bars</option><option value="donut">Donut</option></select><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Custom title"/><button onClick={addGraph} disabled={graphs.length >= 4}>+ Add graph</button></div>
      </div>
      <div className="inbox-graph-grid">{graphs.map((graph) => <article className="inbox-graph-card" key={graph.id}><div className="inbox-graph-card-heading"><div><span>{graph.metric}</span><strong>{graph.title}</strong></div><button aria-label={`Remove ${graph.title}`} onClick={() => onChange(graphs.filter((item) => item.id !== graph.id))}>×</button></div><GraphVisual kind={graph.kind} metric={graph.metric} analytics={analytics} /></article>)}</div>
    </section>
  );
}

function GraphVisual({ kind, metric, analytics }: { kind: GraphConfig["kind"]; metric: string; analytics: AnalyticsSnapshot | null }) {
  if (!analytics || analytics.status !== "live") return <div className="analytics-empty">No synced data yet</div>;
  if (kind === "donut") {
    const total = analytics.queueMix.hot + analytics.queueMix.warm + analytics.queueMix.nurture;
    const hot = total ? (analytics.queueMix.hot / total) * 100 : 0;
    const warm = total ? hot + (analytics.queueMix.warm / total) * 100 : 0;
    return <div className="inbox-donut" style={{ background: `conic-gradient(var(--coral) 0 ${hot}%,var(--amber) ${hot}% ${warm}%,#687080 ${warm}% 100%)` }}><div><strong>{total}</strong><small>leads</small></div></div>;
  }
  const values = metric === "Leads by client" ? analytics.clientLoad.map((item) => item.leads) : analytics.trend;
  if (kind === "bars") {
    const max = Math.max(...values, 1);
    return <div className="inbox-bars">{values.map((value, index) => <i key={index} style={{ height: `${Math.max(5, (value / max) * 100)}%` }} />)}</div>;
  }
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => `${values.length === 1 ? 210 : (index / (values.length - 1)) * 420} ${96 - (value / max) * 82}`).join(" L");
  return values.length ? <svg className="inbox-line" viewBox="0 0 420 110" role="img" aria-label="Live trend graph"><path d={`M${points}`} /><circle cx={values.length === 1 ? 210 : 420} cy={96 - ((values[values.length - 1] / max) * 82)} r="4" /></svg> : <div className="analytics-empty">No synced data yet</div>;
}

function LayoutPanel({
  prefs,
  onChange,
  onSave,
}: {
  prefs: LayoutPrefs;
  onChange: (prefs: LayoutPrefs) => void;
  onSave: () => void;
}) {
  const [dragged, setDragged] = useState<"metrics" | "analytics" | "queue" | null>(null);
  const [draggedMetric, setDraggedMetric] = useState<string | null>(null);
  const labels = { metrics: "Summary metrics", analytics: "Inbox analytics", queue: "Conversation queue" };
  const move = (target: "metrics" | "analytics" | "queue") => {
    if (!dragged || dragged === target) return;
    const order = [...prefs.order];
    const from = order.indexOf(dragged);
    const to = order.indexOf(target);
    if (from >= 0 && to >= 0) {
      order.splice(from, 1);
      order.splice(to, 0, dragged);
      onChange({ ...prefs, order });
    }
    setDragged(null);
  };
  const moveMetric = (target: string) => {
    if (!draggedMetric || draggedMetric === target) return;
    const order = [...prefs.metrics];
    const from = order.indexOf(draggedMetric);
    const to = order.indexOf(target);
    if (from >= 0 && to >= 0) {
      order.splice(from, 1);
      order.splice(to, 0, draggedMetric);
      onChange({ ...prefs, metrics: order });
    }
    setDraggedMetric(null);
  };
  return (
    <div className="customize-popover layout-popover">
      <div className="customize-popover-heading">
        <div><strong>Inbox layout</strong><small>Drag sections into your preferred order.</small></div>
        <span>⌗</span>
      </div>
      <div className="layout-sort-list">
        {prefs.order.map((section) => (
          <div
            className="layout-sort-row"
            key={section}
            draggable
            onDragStart={() => setDragged(section)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => move(section)}
          >
            <span className="drag-handle">⠿</span><strong>{labels[section]}</strong><span className="drag-hint">drag</span>
          </div>
        ))}
      </div>
      <label className="customize-check"><input type="checkbox" checked={prefs.showMetrics} onChange={(event) => onChange({ ...prefs, showMetrics: event.target.checked })} /> Show summary metrics</label>
      <label className="customize-check"><input type="checkbox" checked={prefs.showAnalytics} onChange={(event) => onChange({ ...prefs, showAnalytics: event.target.checked })} /> Show inbox analytics</label>
      <label className="customize-check"><input type="checkbox" checked={prefs.showDetail} onChange={(event) => onChange({ ...prefs, showDetail: event.target.checked })} /> Show conversation detail</label>
      <label className="customize-check"><input type="checkbox" checked={prefs.compact} onChange={(event) => onChange({ ...prefs, compact: event.target.checked })} /> Compact spacing</label>
      <div className="metric-picker-heading"><strong>Summary metrics</strong><small>{prefs.metrics.length}/6 selected</small></div>
      <div className="metric-picker">
        {[...prefs.metrics, ...metricCatalog.map((metric) => metric.id).filter((id) => !prefs.metrics.includes(id))].map((metricId) => {
          const metric = metricCatalog.find((item) => item.id === metricId)!;
          const checked = prefs.metrics.includes(metric.id);
          return <div className="metric-picker-row" key={metric.id} draggable={checked} onDragStart={() => checked && setDraggedMetric(metric.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveMetric(metric.id)}><span className="drag-handle">⠿</span><label className="customize-check"><input type="checkbox" checked={checked} disabled={!checked && prefs.metrics.length >= 6} onChange={() => onChange({ ...prefs, metrics: checked ? prefs.metrics.filter((id) => id !== metric.id) : [...prefs.metrics, metric.id] })} /> {metric.label}</label></div>;
        })}
      </div>
      <button className="customize-save" onClick={onSave}>Save layout</button>
    </div>
  );
}
