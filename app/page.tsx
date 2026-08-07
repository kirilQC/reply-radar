"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import DashboardHome from "./components/DashboardHome";
import AppSidebar from "./components/AppSidebar";

type Lead = {
  initials: string;
  name: string;
  role: string;
  company: string;
  client: string;
  clientTone: string;
  score: number;
  tier: "hot" | "warm" | "nurture";
  reason: string;
  preview: string;
  age: string;
  replies: number;
  avatar: string;
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
type AppearancePrefs = {
  mode: "midnight" | "light";
  zoom: number;
  font: string;
  background: string;
  accent: string;
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
  { id: "needsAction", label: "Needs action", value: "12", delta: "↑ 3", tone: "coral", sub: "since yesterday" },
  { id: "hotConversations", label: "Hot conversations", value: "4", delta: "↑ 2", tone: "purple", sub: "score 80+" },
  { id: "avgReplyTime", label: "Avg. reply time", value: "2.4h", delta: "↓ 18%", tone: "green", sub: "this week" },
  { id: "pipelineSaved", label: "Follow-ups saved", value: "$48.2k", delta: "↑ 12%", tone: "amber", sub: "pipeline influenced" },
  { id: "replyCount7d", label: "Replies · 7 days", value: "86", delta: "↑ 14%", tone: "purple", sub: "across campaigns" },
  { id: "totalReplies", label: "Total replies", value: "1,284", delta: "↑ 9%", tone: "green", sub: "all time" },
  { id: "positiveRate", label: "Positive reply rate", value: "68%", delta: "↑ 5%", tone: "green", sub: "of all replies" },
  { id: "avgRepliesCampaign", label: "Replies / campaign", value: "3.7", delta: "↑ 0.6", tone: "coral", sub: "average" },
];
const leads: Lead[] = [
  {
    initials: "JM",
    name: "Jordan Mendez",
    role: "VP Revenue Operations",
    company: "Northstar AI",
    client: "Northstar",
    clientTone: "#8b7cff",
    score: 94,
    tier: "hot",
    reason: "Asked for pricing 4 days ago, never answered",
    preview: "This is interesting. How does pricing work for a team of 40?",
    age: "4d",
    replies: 4,
    avatar: "#3c365e",
  },
  {
    initials: "AK",
    name: "Aisha Khan",
    role: "Head of Growth",
    company: "Pylon Labs",
    client: "Pylon",
    clientTone: "#55c7a2",
    score: 88,
    tier: "hot",
    reason: "Three replies with increasing detail and a clear timeline",
    preview:
      "We are finalizing the stack this month — can you send over a case study?",
    age: "2h",
    replies: 5,
    avatar: "#254c48",
  },
  {
    initials: "RB",
    name: "Riley Brooks",
    role: "Founder",
    company: "Vectorly",
    client: "Vectorly",
    clientTone: "#f2a36b",
    score: 76,
    tier: "warm",
    reason: "Said ‘circle back in September’ — due today",
    preview: "Let's reconnect after our board meeting in September.",
    age: "1d",
    replies: 3,
    avatar: "#5d3f2d",
  },
  {
    initials: "ST",
    name: "Samira Torres",
    role: "Director of Partnerships",
    company: "Cohort Health",
    client: "Cohort",
    clientTone: "#e6819c",
    score: 71,
    tier: "warm",
    reason: "Replied quickly, but objection is still unresolved",
    preview: "I like the idea, but implementation is our concern right now.",
    age: "6h",
    replies: 2,
    avatar: "#5d3043",
  },
  {
    initials: "NW",
    name: "Noah Williams",
    role: "COO",
    company: "Harbor Systems",
    client: "Harbor",
    clientTone: "#6fafe5",
    score: 52,
    tier: "nurture",
    reason: "Warm thread went quiet after our last message",
    preview: "Thanks for the context. I will share with the team.",
    age: "8d",
    replies: 2,
    avatar: "#294766",
  },
  {
    initials: "EC",
    name: "Elena Chen",
    role: "VP Marketing",
    company: "Goodline",
    client: "Goodline",
    clientTone: "#cfaa61",
    score: 46,
    tier: "nurture",
    reason: "Positive reply, no explicit next step yet",
    preview: "This looks relevant for the team. Keep me posted.",
    age: "11d",
    replies: 1,
    avatar: "#564521",
  },
];
const nav = [
  ["inbox", "Priority inbox", "⌘1"],
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
    [search, setSearch] = useState(""),
    [theme, setTheme] = useState("midnight"),
    [sent, setSent] = useState(false),
    [sidebarOpen, setSidebarOpen] = useState(false);
  const [layoutPrefs, setLayoutPrefs] = useState(defaultLayout);
  const [appearance, setAppearance] = useState(defaultAppearance);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [clientParam] = useState(() =>
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("client")
      : null,
  );
  const [profileParam] = useState(() =>
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("profile")
      : null,
  );
  const assignedClients =
    profileParam === "alex-spencer"
      ? ["Northstar", "Pylon"]
      : profileParam === "jordan-lee"
        ? ["Vectorly"]
        : profileParam === "maya-patel"
          ? ["Northstar", "Vectorly"]
          : null;
  const profileName =
    profileParam === "alex-spencer"
      ? "Alex Spencer"
      : profileParam === "jordan-lee"
        ? "Jordan Lee"
        : profileParam === "maya-patel"
          ? "Maya Patel"
          : null;
  const trackedClients = assignedClients ?? ["Northstar", "Pylon", "Vectorly"];
  const trackedWorkspaceSlugs = trackedClients.map((client) => client.toLowerCase());
  const greeting =
    new Date().getHours() < 12
      ? "Good morning"
      : new Date().getHours() < 18
        ? "Good afternoon"
        : "Good evening";
  const clientName =
    clientParam === "northstar"
      ? "Northstar AI"
      : clientParam === "pylon"
        ? "Pylon Labs"
        : clientParam === "vectorly"
          ? "Vectorly"
          : "All clients";
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
  const savePreferences = (nextLayout = layoutPrefs, nextAppearance = appearance) => {
    const payload = { layout: nextLayout, appearance: nextAppearance };
    window.localStorage.setItem(preferenceKey, JSON.stringify(payload));
    // Also retain the device-level fallback for the general inbox.
    window.localStorage.setItem("reply-radar-prefs:general", JSON.stringify(payload));
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
    const filterButton = document.querySelector<HTMLButtonElement>(
      ".queue-tools .filter-button",
    );
    const sortButton = document.querySelector<HTMLButtonElement>(
      ".queue-tools .filter-button + .filter-button",
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
    const filterHandler = () =>
      toast("Filter menu ready — use All follow-ups, Hot, or Snoozed above.");
    const sortHandler = () => toast("Sorted by urgency score (highest first).");
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
    filterButton?.addEventListener("click", filterHandler);
    sortButton?.addEventListener("click", sortHandler);
    exportButton?.addEventListener("click", exportHandler);
    addButton?.addEventListener("click", addHandler);
    return () => {
      workspace?.removeEventListener("click", workspaceHandler);
      clientHandlers.forEach(([button, handler]) =>
        button.removeEventListener("click", handler),
      );
      filterButton?.removeEventListener("click", filterHandler);
      sortButton?.removeEventListener("click", sortHandler);
      exportButton?.removeEventListener("click", exportHandler);
      addButton?.removeEventListener("click", addHandler);
    };
  }, []);
  const current = leads[selected];
  const filtered = useMemo(
    () =>
      leads.filter(
        (lead) =>
          (!search ||
            `${lead.name} ${lead.company} ${lead.client}`
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (!assignedClients || assignedClients.includes(lead.client)) &&
          (filter === "All follow-ups" ||
            (filter === "Hot" ? lead.tier === "hot" : lead.tier !== "hot")),
      ),
    [search, filter, assignedClients],
  );
  return (
    <main
      className={`app-shell ${theme === "light" ? "light-mode" : ""} ${layoutPrefs.compact ? "compact-inbox" : ""}`}
      style={{
        "--accent": appearance.accent,
        "--bg": appearance.background,
        "--font": appearance.font,
        zoom: appearance.zoom / 100,
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
          <button>
            <i style={{ background: "#8b7cff" }}>N</i>Northstar AI{" "}
            <span>6</span>
          </button>
          <button>
            <i style={{ background: "#55c7a2" }}>P</i>Pylon Labs <span>3</span>
          </button>
          <button>
            <i style={{ background: "#f2a36b" }}>V</i>Vectorly <span>2</span>
          </button>
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item">
            <Icon name="settings" />
            <span>Admin console</span>
          </button>
          <div className="user-chip">
            <div className="user-avatar">AS</div>
            <div>
              <strong>Alex Spencer</strong>
              <small>Agency owner</small>
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
            <label className="search">
              <Icon name="search" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search leads, companies..."
              />
              <kbd>⌘ K</kbd>
            </label>
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
                LIVE QUEUE <span className="eyebrow-separator">/</span> WED, AUG
                06
              </div>
              <h1>
                {profileName ? `${greeting}, ${profileName}` : "General inbox"}
              </h1>
              <p>
                {filtered.length} leads across {trackedClients.length} clients
              </p>
              <div className="tracked-clients">
                {trackedClients.map((client) => (
                  <span key={client}>{client}</span>
                ))}
              </div>
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
              <strong>All systems operational</strong>
              <span>Last event received 24s ago · 1,284 events today</span>
            </div>
            <div className="health-bars">
              {[
                3, 5, 4, 8, 6, 8, 10, 8, 11, 10, 13, 12, 15, 13, 16, 15, 17, 14,
                19, 18, 22, 20, 23, 22,
              ].map((h, i) => (
                <i key={i} style={{ height: `${h * 2}px` }} />
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
                Priority queue <span>12</span>
              </h2>
              <p>Ranked by urgency and conversation intent</p>
            </div>
            <div className="queue-tools">
              <div className="heading-actions inbox-actions">
                <button className="secondary-button">
                  Export <span>↓</span>
                </button>
                <button className="primary-button">+ Add follow-up</button>
              </div>
              <div className="segmented">
                {["All follow-ups", "Hot", "Snoozed"].map((f) => (
                  <button
                    key={f}
                    className={filter === f ? "selected" : ""}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                    {f === "Hot" && <b>4</b>}
                  </button>
                ))}
              </div>
              <button className="filter-button">
                Filter <span>⌄</span>
              </button>
              <button className="filter-button">
                Sort: Score <span>⌄</span>
              </button>
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
              {filtered.map((lead, index) => (
                <button
                  className={`lead-row ${selected === index ? "row-selected" : ""}`}
                  key={lead.name}
                  onClick={() => setSelected(index)}
                >
                  <div className="lead-main">
                    <div
                      className="lead-avatar"
                      style={{ background: lead.avatar }}
                    >
                      {lead.initials}
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
                      {lead.client[0]}
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
                <span>Showing {filtered.length} of 12 conversations</span>
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
                    {current.initials}
                  </div>
                  <div>
                    <h3>{current.name}</h3>
                    <p>
                      {current.role} at {current.company}
                    </p>
                    <span className="linkedin">
                      in&nbsp; LinkedIn profile ↗
                    </span>
                  </div>
                </div>
                <div className="detail-tags">
                  <span className={`score-pill ${current.tier}`}>
                    {current.score} · {current.tier}
                  </span>
                  <span className="tag-outline">{current.client}</span>
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
                <div className="thread-date">TUE, AUG 05</div>
                <div className="bubble inbound">
                  <span>JM</span>
                  <p>{current.preview}</p>
                  <time>11:42 AM</time>
                </div>
                <div className="bubble outbound">
                  <p>
                    Great question — let me pull together the right context for
                    your team and send it over.
                  </p>
                  <time>11:46 AM · You</time>
                </div>
                <div className="thread-date today">TODAY</div>
                <div className="bubble inbound">
                  <span>JM</span>
                  <p>
                    That would be great. We are looking at a few options right
                    now.
                  </p>
                  <time>9:18 AM</time>
                </div>
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
                      : "Absolutely — I’ll send over a concise comparison with pricing tiers and a relevant case study. Would it be helpful to include implementation timelines for a 40-person team?"
                  }
                />
                <div className="composer-foot">
                  <span>134 / 300 characters</span>
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

function AppearancePanel({
  prefs,
  onChange,
  onSave,
}: {
  prefs: AppearancePrefs;
  onChange: (prefs: AppearancePrefs) => void;
  onSave: () => void;
}) {
  return (
    <div className="customize-popover appearance-popover">
      <div className="customize-popover-heading">
        <div><strong>Appearance</strong><small>Saved to this profile and device.</small></div>
        <span>◐</span>
      </div>
      <label className="customize-field">MODE<select value={prefs.mode} onChange={(event) => onChange({ ...prefs, mode: event.target.value as AppearancePrefs["mode"] })}><option value="midnight">Dark</option><option value="light">Light</option></select></label>
      <label className="customize-field">ZOOM <b>{prefs.zoom}%</b><input type="range" min="85" max="120" step="5" value={prefs.zoom} onChange={(event) => onChange({ ...prefs, zoom: Number(event.target.value) })} /></label>
      <label className="customize-field">FONT<select value={prefs.font} onChange={(event) => onChange({ ...prefs, font: event.target.value })}><option value="Inter, ui-sans-serif, system-ui, sans-serif">Inter / System</option><option value="Georgia, serif">Georgia</option><option value="ui-monospace, SFMono-Regular, Menlo, monospace">Mono</option><option value="Arial, sans-serif">Arial</option></select></label>
      <div className="customize-color-row"><label className="customize-field">BACKGROUND<input type="color" value={prefs.background} onChange={(event) => onChange({ ...prefs, background: event.target.value })} /></label><label className="customize-field">ACCENT<input type="color" value={prefs.accent} onChange={(event) => onChange({ ...prefs, accent: event.target.value })} /></label></div>
      <button className="customize-save" onClick={onSave}>Save appearance</button>
    </div>
  );
}
