"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DashboardHome from "./components/DashboardHome";
import AppSidebar from "./components/AppSidebar";
import AppearancePanel, {
  type AppearancePrefs,
} from "./components/AppearancePanel";

type Lead = {
  id: string;
  leadId?: string;
  initials: string;
  name: string;
  role: string;
  company: string;
  client: string;
  clientSlug?: string;
  clientTone: string;
  score: number;
  leadScore?: number | null;
  followUpScore?: number;
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
  campaignName?: string | null;
  headline?: string | null;
  companyPhotoUrl?: string | null;
  enriched?: boolean;
  industry?: unknown;
  enrichedLocation?: unknown;
  sentiment?: string | null;
  followUpUrgency?: number;
  followUpReason?: string | null;
  lastMessageAt?: string | null;
  latestReplyAt?: string | null;
  messages: Array<{
    id: string;
    body: string;
    direction: string;
    sentAt: string;
    authorName: string;
  }>;
};
type LayoutPrefs = {
  order: Array<"metrics" | "analytics" | "queue">;
  showMetrics: boolean;
  showAnalytics: boolean;
  showDetail: boolean;
  compact: boolean;
  metrics: string[];
  graphs: GraphConfig[];
  paneSplit: number;
  starredLeadIds: string[];
};
type GraphConfig = {
  id: string;
  title: string;
  metric: string;
  kind: "line" | "bars" | "donut";
};
type AnalyticsSnapshot = {
  status: "live" | "no_data" | "not_configured" | "error";
  totalReplies: number;
  replies7d: number;
  trend: number[];
  queueMix: { hot: number; warm: number; nurture: number };
  clientLoad: Array<{ name: string; leads: number }>;
  averageResponseMinutes?: number | null;
  campaignAverages?: { replyRate: number; acceptanceRate: number; positiveReplyRate: number };
};
type QuickTemplate = { id: string; name: string; value: string };
const defaultLayout: LayoutPrefs = {
  order: ["metrics", "queue", "analytics"],
  showMetrics: true,
  showAnalytics: true,
  showDetail: true,
  compact: false,
  metrics: ["avgRepliesCampaign", "acceptanceRate", "positiveRate", "totalReplies"],
  graphs: [
    {
      id: "reply-volume",
      title: "Reply volume",
      metric: "Replies · 7 days",
      kind: "line",
    },
    {
      id: "queue-mix",
      title: "Queue mix",
      metric: "Lead status",
      kind: "donut",
    },
  ],
  paneSplit: 62,
  starredLeadIds: [],
};
const clientCampaignMetricIds = [
  "avgRepliesCampaign",
  "acceptanceRate",
  "positiveRate",
  "totalReplies",
];
const defaultAppearance: AppearancePrefs = {
  mode: "midnight",
  zoom: 100,
  font: "Inter, ui-sans-serif, system-ui, sans-serif",
  background: "#0b0c10",
  accent: "#8b7cff",
  accent2: "",
  timeZone: "America/New_York",
};
const timeZoneSuffix: Record<string, string> = {
  "America/New_York": "EST",
  "America/Chicago": "CST",
  "America/Denver": "MST",
  "America/Los_Angeles": "PST",
  "Pacific/Honolulu": "HST",
  UTC: "UTC",
};
const formatDashboardDateParts = (
  value: string | null | undefined,
  timeZone: string,
) => {
  if (!value) return { date: "—", time: "" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: "—", time: "" };
  const dateText = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const timeText = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  const fallbackSuffix =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  return {
    date: dateText,
    time: `${timeText} ${timeZoneSuffix[timeZone] ?? fallbackSuffix}`,
  };
};
const formatDashboardDate = (
  value: string | null | undefined,
  timeZone: string,
) => {
  const parts = formatDashboardDateParts(value, timeZone);
  return [parts.date, parts.time].filter(Boolean).join(", ");
};
const metricCatalog = [
  {
    id: "needsAction",
    label: "Needs action",
    value: "—",
    delta: "",
    tone: "coral",
    sub: "Awaiting synced data",
  },
  {
    id: "hotConversations",
    label: "Hot conversations",
    value: "—",
    delta: "",
    tone: "purple",
    sub: "Awaiting synced data",
  },
  {
    id: "avgReplyTime",
    label: "Avg. reply time",
    value: "—",
    delta: "",
    tone: "green",
    sub: "Awaiting synced data",
  },
  {
    id: "pipelineSaved",
    label: "Follow-ups saved",
    value: "—",
    delta: "",
    tone: "amber",
    sub: "Awaiting synced data",
  },
  {
    id: "replyCount7d",
    label: "Replies · 7 days",
    value: "—",
    delta: "",
    tone: "purple",
    sub: "Awaiting synced data",
  },
  {
    id: "totalReplies",
    label: "Total replies",
    value: "—",
    delta: "",
    tone: "green",
    sub: "Awaiting synced data",
  },
  {
    id: "positiveRate",
    label: "Average positive reply rate",
    value: "—",
    delta: "",
    tone: "green",
    sub: "Awaiting synced data",
  },
  {
    id: "avgRepliesCampaign",
    label: "Average reply rate",
    value: "—",
    delta: "",
    tone: "coral",
    sub: "Awaiting synced data",
  },
  {
    id: "acceptanceRate",
    label: "Average acceptance rate",
    value: "—",
    delta: "",
    tone: "amber",
    sub: "Awaiting synced data",
  },
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
  const [excludedClients, setExcludedClients] = useState<string[]>([]);
  const [visibleLeadCount, setVisibleLeadCount] = useState(10);
  const [messagingDocUrl, setMessagingDocUrl] = useState("");
  const [quickTemplates, setQuickTemplates] = useState<QuickTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateDraft, setTemplateDraft] = useState({ name: "", value: "" });
  const [aiDraft, setAiDraft] = useState("");
  const [aiReason, setAiReason] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [workspaceAi, setWorkspaceAi] = useState({ model: "", brief: "", systemPrompt: "" });
  const [workspaceDirectory, setWorkspaceDirectory] = useState<
    Array<{
      name: string;
      slug: string;
      tone?: string;
      logoUrl?: string;
      website?: string;
      messagingDocUrl?: string;
    }>
  >([]);
  const [liveProfiles, setLiveProfiles] = useState<
    Array<{ slug: string; name: string; clients: string[] }>
  >([]);
  const paneGridRef = useRef<HTMLDivElement>(null);
  const paneSplitRef = useRef(defaultLayout.paneSplit);
  const threadEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scale = appearance.zoom / 100;
    const root = document.documentElement;
    root.style.setProperty("--reply-radar-zoom", String(scale));
  }, [appearance.zoom]);
  useEffect(() => {
    paneSplitRef.current = layoutPrefs.paneSplit;
  }, [layoutPrefs.paneSplit]);
  useEffect(() => {
    // URL search params are client-only state on this static route.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueryString(window.location.search);
    const refreshWorkspaces = () => {
      try {
        const saved = window.localStorage.getItem("reply-radar-workspaces:v2");
        if (saved)
          setWorkspaceDirectory(
            (
              JSON.parse(saved) as Array<{
                name: string;
                slug: string;
                tone?: string;
                logoUrl?: string;
                website?: string;
              }>
            ).sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
            ),
          );
        const savedProfiles = window.localStorage.getItem(
          "reply-radar-profiles:v2",
        );
        if (savedProfiles) setLiveProfiles(JSON.parse(savedProfiles));
      } catch {
        /* keep the empty live state */
      }
      void fetch("/api/admin/workspaces", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (!Array.isArray(payload?.workspaces)) return;
          setWorkspaceDirectory(
            payload.workspaces
              .map((item: Record<string, unknown>) => ({
                name: String(item.name ?? ""),
                slug: String(item.slug ?? ""),
                tone: String(item.accent_color ?? "var(--accent)"),
                logoUrl: String(item.logo_url ?? ""),
                website: String(item.website_url ?? ""),
                messagingDocUrl: String((item.guardrails as Record<string, unknown> | undefined)?.messaging_doc_url ?? ""),
              }))
              .sort((a: { name: string }, b: { name: string }) =>
                a.name.localeCompare(b.name, undefined, {
                  sensitivity: "base",
                }),
              ),
          );
        })
        .catch(() => null);
      void fetch("/api/admin/profiles", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (Array.isArray(payload?.profiles))
            setLiveProfiles(payload.profiles);
        })
        .catch(() => null);
    };
    refreshWorkspaces();
    window.addEventListener(
      "reply-radar-workspaces-changed",
      refreshWorkspaces,
    );
    window.addEventListener("reply-radar-profiles-changed", refreshWorkspaces);
    window.addEventListener("storage", refreshWorkspaces);
    return () => {
      window.removeEventListener(
        "reply-radar-workspaces-changed",
        refreshWorkspaces,
      );
      window.removeEventListener(
        "reply-radar-profiles-changed",
        refreshWorkspaces,
      );
      window.removeEventListener("storage", refreshWorkspaces);
    };
  }, []);
  useEffect(() => {
    if (new URLSearchParams(queryString).get("appearance") === "1")
      setAppearanceOpen(true);
  }, [queryString]);
  const query = new URLSearchParams(queryString);
  const clientParam = query.get("client");
  const profileParam = query.get("profile");
  const liveProfile = liveProfiles.find(
    (profile) => profile.slug === profileParam,
  );
  const clientLabel = (name: string) => {
    const workspace = workspaceDirectory.find((item) => item.name === name);
    return workspace?.name || name;
  };
  const assignedClients = liveProfile
    ? liveProfile.clients.map(clientLabel)
    : clientParam
      ? [
          workspaceDirectory.find((item) => item.slug === clientParam)?.name ||
            clientParam,
        ]
      : null;
  const profileName = liveProfile?.name ?? null;
  const allWorkspaceNames = workspaceDirectory
    .map((item) => item.name)
    .filter(Boolean);
  const trackedClients = assignedClients ?? allWorkspaceNames;
  const trackedWorkspaceSlugs = trackedClients.map(
    (client) =>
      workspaceDirectory.find((item) => item.name === client)?.slug ||
      client.toLowerCase(),
  );
  const greeting =
    new Date().getHours() < 12
      ? "Good morning"
      : new Date().getHours() < 18
        ? "Good afternoon"
        : "Good evening";
  const activeWorkspace = clientParam
    ? workspaceDirectory.find((item) => item.slug === clientParam)
    : undefined;
  const clientName = activeWorkspace?.name || clientParam || "All clients";
  const clientTone = activeWorkspace?.tone || "var(--accent)";
  const clientLogo = activeWorkspace?.logoUrl || "";
  const clientWebsite = activeWorkspace?.website?.trim()
    ? /^https?:\/\//i.test(activeWorkspace.website.trim())
      ? activeWorkspace.website.trim()
      : `https://${activeWorkspace.website.trim()}`
    : "";
  const preferenceScope = profileParam
    ? `profile:${profileParam}`
    : clientParam
      ? `client:${clientParam}`
      : "general";
  const preferenceKey = `reply-radar-prefs:${preferenceScope}`;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(preferenceKey);
        const fallback = window.localStorage.getItem(
          "reply-radar-prefs:general",
        );
        const cookieValue = document.cookie
          .split("; ")
          .find((item) => item.startsWith("reply-radar-preferences="))
          ?.split("=")[1];
        const parsed = JSON.parse(
          saved ||
            fallback ||
            (cookieValue ? decodeURIComponent(cookieValue) : "null"),
        );
        if (parsed?.layout) {
          const nextLayout = { ...defaultLayout, ...parsed.layout };
          nextLayout.starredLeadIds = Array.isArray(nextLayout.starredLeadIds)
            ? nextLayout.starredLeadIds.map(String)
            : [];
          nextLayout.order = Array.from(
            new Set([...nextLayout.order, "metrics", "analytics", "queue"]),
          ).filter((item) =>
            ["metrics", "analytics", "queue"].includes(item),
          ) as LayoutPrefs["order"];
          if (clientParam) nextLayout.metrics = clientCampaignMetricIds;
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
    fetch(`/api/preferences?scope=${encodeURIComponent(preferenceScope)}`, {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled || !payload?.preferences) return;
        if (payload.preferences.layout)
          setLayoutPrefs((current) => ({
            ...current,
            ...payload.preferences.layout,
            ...(clientParam ? { metrics: clientCampaignMetricIds } : {}),
            starredLeadIds: Array.isArray(
              payload.preferences.layout.starredLeadIds,
            )
              ? payload.preferences.layout.starredLeadIds.map(String)
              : current.starredLeadIds,
          }));
        if (payload.preferences.appearance)
          setAppearance((current) => ({
            ...current,
            ...payload.preferences.appearance,
          }));
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [preferenceScope]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/analytics?workspaces=${trackedWorkspaceSlugs.join(",")}`, {
      cache: "no-store",
    })
      .then((response) => response.json())
      .then((payload: AnalyticsSnapshot) => {
        if (!cancelled) setAnalytics(payload);
      })
      .catch(() => {
        if (!cancelled)
          setAnalytics({
            status: "error",
            totalReplies: 0,
            replies7d: 0,
            trend: [],
            queueMix: { hot: 0, warm: 0, nurture: 0 },
            clientLoad: [],
          });
      });
    return () => {
      cancelled = true;
    };
  }, [trackedClients.join(",")]);
  useEffect(() => {
    let cancelled = false;
    setInboxLoading(true);
    setInboxError("");
    fetch(
      `/api/inbox?workspaces=${encodeURIComponent(trackedWorkspaceSlugs.join(","))}`,
      { cache: "no-store" },
    )
      .then(async (response) => ({
        response,
        payload: await response.json().catch(() => ({})),
      }))
      .then(({ response, payload }) => {
        if (cancelled) return;
        if (!response.ok)
          throw new Error(
            String(payload.error ?? "Inbox could not be loaded."),
          );
        setLeads(
          Array.isArray(payload.conversations) ? payload.conversations : [],
        );
      })
      .catch((error) => {
        if (!cancelled) {
          setLeads([]);
          setInboxError(
            error instanceof Error
              ? error.message
              : "Inbox could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setInboxLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trackedWorkspaceSlugs.join(",")]);
  const savePreferences = (
    nextLayout = layoutPrefs,
    nextAppearance = appearance,
  ) => {
    const payload = { layout: nextLayout, appearance: nextAppearance };
    window.localStorage.setItem(preferenceKey, JSON.stringify(payload));
    // Also retain the device-level fallback for the general inbox.
    window.localStorage.setItem(
      "reply-radar-prefs:general",
      JSON.stringify(payload),
    );
    // Apply the same settings to the document immediately so they remain global
    // while navigating between routes (not just on the inbox's local <main>).
    const root = document.documentElement;
    root.style.setProperty("--accent", nextAppearance.accent);
    if (nextAppearance.accent2) root.style.setProperty("--accent-2", `color-mix(in srgb, ${nextAppearance.accent2} 25%, var(--panel))`);
    root.style.setProperty("--bg", nextAppearance.background);
    root.style.setProperty("--font", nextAppearance.font);
    root.style.setProperty(
      "--reply-radar-zoom",
      `${nextAppearance.zoom / 100}`,
    );
    document.body.classList.toggle(
      "light-mode",
      nextAppearance.mode === "light",
    );
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
  const filtered = useMemo(() => {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dayOfWeek = now.getDay(); // 0 = Sunday
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - dayOfWeek); // back to Sunday
      return leads
        .filter(
          (lead) =>
            (!search ||
              `${lead.name} ${lead.company} ${lead.client}`
                .toLowerCase()
                .includes(search.toLowerCase())) &&
            (!assignedClients || assignedClients.includes(lead.client)) &&
            !excludedClients.includes(lead.client) &&
            (() => {
              if (filter === "All follow-ups") return true;
              if (filter === "Starred") return layoutPrefs.starredLeadIds.includes(String(lead.leadId || lead.id));
              if (filter === "today") {
                const replyAt = new Date(String(lead.latestReplyAt || lead.lastMessageAt));
                return replyAt >= todayStart;
              }
              if (filter === "week") {
                const replyAt = new Date(String(lead.latestReplyAt || lead.lastMessageAt));
                return replyAt >= weekStart;
              }
              if (filter === "follow-ups") {
                return (lead.followUpUrgency ?? 0) > 0;
              }
              if (["Hot", "Warm", "Nurture"].includes(filter)) return lead.tier === filter.toLowerCase();
              return true;
            })(),
        )
        .sort((a, b) => {
          if (filter === "follow-ups") {
            // Sort by urgency score descending — most urgent first
            return (b.followUpUrgency ?? 0) - (a.followUpUrgency ?? 0);
          }
          return sort === "newest"
            ? new Date(String(b.lastMessageAt)).getTime() -
              new Date(String(a.lastMessageAt)).getTime()
            : sort === "oldest"
              ? new Date(String(a.lastMessageAt)).getTime() -
                new Date(String(b.lastMessageAt)).getTime()
              : sort === "name"
                ? a.name.localeCompare(b.name)
                : b.score - a.score;
        });
    },
    [
      leads,
      search,
      filter,
      sort,
      assignedClients,
      excludedClients,
      layoutPrefs.starredLeadIds,
    ],
  );
  useEffect(() => {
    setVisibleLeadCount(10);
    setSelected(0);
  }, [filter, search, sort, clientParam, profileParam]);
  const visibleLeads = filtered.slice(0, visibleLeadCount);
  const liveMetric = (metric: (typeof metricCatalog)[number]) => {
    const averages = analytics?.campaignAverages;
    const filterLabel = filter === "today" ? "today" : filter === "week" ? "this week" : filter === "follow-ups" ? "needing follow-up" : "total";
    const positiveCount = filtered.filter((l) => l.sentiment === "positive").length;
    const neutralCount = filtered.filter((l) => l.sentiment === "neutral").length;
    const negativeCount = filtered.filter((l) => l.sentiment === "negative").length;
    const totalReplies = filtered.reduce((sum, l) => sum + l.replies, 0);
    const positiveRate = filtered.length ? ((positiveCount / filtered.length) * 100).toFixed(1) : "0.0";
    const values: Record<string, { value: string; sub: string }> = {
      needsAction: { value: String(filtered.length), sub: `Conversations ${filterLabel}` },
      hotConversations: { value: String(positiveCount), sub: `Positive replies ${filterLabel}` },
      avgReplyTime: { value: String(neutralCount), sub: `Neutral replies ${filterLabel}` },
      pipelineSaved: { value: String(negativeCount), sub: `Negative replies ${filterLabel}` },
      replyCount7d: { value: String(totalReplies), sub: `Inbound replies ${filterLabel}` },
      totalReplies: { value: String(totalReplies), sub: `Inbound replies ${filterLabel}` },
      positiveRate: { value: `${positiveRate}%`, sub: `Positive rate ${filterLabel}` },
      avgRepliesCampaign: { value: filtered.length ? `${((filtered.filter((l) => l.replies > 0).length / filtered.length) * 100).toFixed(1)}%` : "—", sub: `Reply rate ${filterLabel}` },
      acceptanceRate: { value: averages ? `${averages.acceptanceRate.toFixed(1)}%` : "—", sub: "Campaign acceptance rate (all time)" },
    };
    return { ...metric, ...(values[metric.id] ?? {}) };
  };
  const toggleStar = (lead: Lead) => {
    const id = String(lead.leadId || lead.id);
    const starredLeadIds = layoutPrefs.starredLeadIds.includes(id)
      ? layoutPrefs.starredLeadIds.filter((item) => item !== id)
      : [...layoutPrefs.starredLeadIds, id];
    const next = { ...layoutPrefs, starredLeadIds };
    setLayoutPrefs(next);
    savePreferences(next, appearance);
  };
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
  const latestInboundMessageId = [...current.messages]
    .reverse()
    .find((message) => message.direction !== "outbound")?.id;
  useEffect(() => {
    if (current.id === "empty") return;
    requestAnimationFrame(() => {
      const el = threadEndRef.current;
      if (!el) return;
      // Scroll only the thread container, not the whole page
      const container = el.closest(".thread");
      if (container) container.scrollTop = container.scrollHeight;
    });
  }, [current.id]);
  const selectedWorkspaceSlug = current.clientSlug || clientParam || "";
  const generateAiReview = async (ai = workspaceAi) => {
    if (!current.messages.length || current.id === "empty") return;
    setAiLoading(true);
    const response = await fetch("/api/ai/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "analyze", model: ai.model || undefined, system: ai.systemPrompt || undefined, conversationId: current.id, workspaceId: selectedWorkspaceSlug, workspaceName: current.client, thread: current.messages, instruction: `Use the entire conversation. Write in a natural, concise business tone. Do not invent facts, promises, links, or meeting times.${ai.brief ? ` Client context: ${ai.brief}` : ""}` }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    if (response?.ok) {
      setAiDraft(String(payload.draft ?? ""));
      setAiReason(String(payload.reason ?? "This lead sent a new reply that is ready for review."));
    } else {
      setAiDraft("");
      setAiReason("AI review is temporarily unavailable. The new reply is still ready for manual review.");
    }
    setAiLoading(false);
  };
  useEffect(() => {
    setAiDraft("");
    setAiReason("");
    setTemplatesOpen(false);
    if (!selectedWorkspaceSlug) { setMessagingDocUrl(""); setQuickTemplates([]); setWorkspaceAi({ model: "", brief: "", systemPrompt: "" }); return; }
    let cancelled = false;
    fetch(`/api/client-resources?workspace=${encodeURIComponent(selectedWorkspaceSlug)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (cancelled || !payload?.workspace) return;
        setMessagingDocUrl(String(payload.workspace.messagingDocUrl ?? ""));
        setQuickTemplates(Array.isArray(payload.workspace.quickTemplates) ? payload.workspace.quickTemplates : []);
        const ai = { model: String(payload.workspace.model ?? ""), brief: String(payload.workspace.brief ?? ""), systemPrompt: String(payload.workspace.systemPrompt ?? "") };
        setWorkspaceAi(ai);
        void generateAiReview(ai);
      }).catch(() => null);
    return () => { cancelled = true; };
    // The selected conversation is the intentional refresh boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, selectedWorkspaceSlug]);
  const syncTemplates = async (next: QuickTemplate[]) => {
    setQuickTemplates(next);
    if (!selectedWorkspaceSlug) return;
    await fetch("/api/client-resources", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace: selectedWorkspaceSlug, quickTemplates: next }) }).catch(() => null);
  };
  const clientLogoFor = (lead: Lead) =>
    lead.clientLogoUrl ||
    workspaceDirectory.find(
      (workspace) =>
        workspace.slug === lead.clientSlug || workspace.name === lead.client,
    )?.logoUrl ||
    null;
  const beginPaneResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const grid = paneGridRef.current;
    if (!grid) return;
    event.preventDefault();
    const rect = grid.getBoundingClientRect();
    const update = (clientX: number) => {
      const next = Math.max(
        40,
        Math.min(75, Math.round(((clientX - rect.left) / rect.width) * 100)),
      );
      paneSplitRef.current = next;
      setLayoutPrefs((currentPrefs) => ({ ...currentPrefs, paneSplit: next }));
    };
    const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    const finish = () => {
      document.body.classList.remove("resizing-panes");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      savePreferences(
        { ...layoutPrefs, paneSplit: paneSplitRef.current },
        appearance,
      );
    };
    document.body.classList.add("resizing-panes");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  return (
    <main
      className={`app-shell ${theme === "light" ? "light-mode" : ""} ${layoutPrefs.compact ? "compact-inbox" : ""}`}
      style={
        {
          "--accent": appearance.accent,
          "--bg": appearance.background,
          "--font": appearance.font,
          fontFamily: appearance.font,
        } as React.CSSProperties
      }
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
              <i style={{ background: workspace.tone ?? "var(--accent)" }}>
                {workspace.name?.[0] ?? "?"}
              </i>
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
            {messagingDocUrl && (
              <a className="icon-button messaging-doc-shortcut" href={messagingDocUrl} target="_blank" rel="noreferrer" aria-label="Open client messaging document" title="Open client messaging document">▤</a>
            )}
            <div className="notepad-dropdown-wrap">
              <button
                className="icon-button notepad-toggle"
                aria-label="Quick templates notepad"
                title="Quick templates notepad"
                onClick={() => setTemplatesOpen((open) => !open)}
              >
                ≡
              </button>
              {templatesOpen && (
                <div className="notepad-dropdown">
                  <div className="notepad-header">
                    <strong>Quick Templates</strong>
                    <button type="button" onClick={() => setTemplatesOpen(false)}>×</button>
                  </div>
                  <div className="notepad-body">
                    {quickTemplates.map((template) => (
                      <div className="notepad-entry" key={template.id}>
                        <div className="notepad-entry-content" onClick={() => { navigator.clipboard.writeText(template.value).catch(() => null); }}>
                          <small>{template.name}</small>
                          <span>{template.value}</span>
                        </div>
                        <button type="button" className="notepad-entry-remove" onClick={() => void syncTemplates(quickTemplates.filter((item) => item.id !== template.id))}>×</button>
                      </div>
                    ))}
                    {!quickTemplates.length && <p className="notepad-empty">No templates saved yet.</p>}
                  </div>
                  <div className="notepad-form">
                    <input placeholder="Variable name" value={templateDraft.name} onChange={(event) => setTemplateDraft((draft) => ({ ...draft, name: event.target.value }))} />
                    <textarea placeholder="Value or reusable text" value={templateDraft.value} onChange={(event) => setTemplateDraft((draft) => ({ ...draft, value: event.target.value }))} />
                    <button type="button" disabled={!templateDraft.name.trim() || !templateDraft.value.trim()} onClick={() => { const next = [...quickTemplates, { id: crypto.randomUUID(), name: templateDraft.name.trim(), value: templateDraft.value.trim() }]; setTemplateDraft({ name: "", value: "" }); void syncTemplates(next); }}>Save</button>
                  </div>
                </div>
              )}
            </div>
            {clientParam && (
              <a
                className="icon-button client-config-shortcut"
                href={`/admin?client=${encodeURIComponent(clientParam)}`}
                aria-label={`Configure ${clientName}`}
                title={`Configure ${clientName}`}
              >
                ↗
              </a>
            )}
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
        <div className="content-wrap inbox-page-content">
          <div className="page-heading">
            <div>
              <h1>
                {clientParam ? (
                  clientWebsite ? (
                    <a
                      className="inbox-client-heading-link"
                      href={clientWebsite}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span
                        className="inbox-heading-logo"
                        style={
                          clientLogo ? undefined : { background: clientTone }
                        }
                      >
                        {clientLogo ? (
                          <img src={clientLogo} alt={`${clientName} logo`} />
                        ) : (
                          clientName[0]
                        )}
                      </span>
                      <span>{clientName}</span>
                    </a>
                  ) : (
                    <>
                      <span
                        className="inbox-heading-logo"
                        style={
                          clientLogo ? undefined : { background: clientTone }
                        }
                      >
                        {clientLogo ? (
                          <img src={clientLogo} alt={`${clientName} logo`} />
                        ) : (
                          clientName[0]
                        )}
                      </span>
                      {clientName}
                    </>
                  )
                ) : (
                  <>
                    {!profileName && (
                      <span className="inbox-heading-logo general-heading-logo">
                        <img src="/qc-growth-logo.png" alt="QC Growth logo" />
                      </span>
                    )}
                    {profileName
                      ? `${greeting}, ${profileName}`
                      : "General inbox"}
                  </>
                )}
              </h1>
              {!clientParam && (
                <div
                  className="tracked-clients"
                  aria-label="Temporarily hide client replies"
                >
                  {trackedClients.map((client) => {
                    const excluded = excludedClients.includes(client);
                    const workspace = workspaceDirectory.find(
                      (item) => item.name === client,
                    );
                    return (
                      <button
                        key={client}
                        className={excluded ? "excluded" : ""}
                        aria-label={
                          excluded
                            ? `Show ${client} replies`
                            : `Hide ${client} replies until refresh`
                        }
                        aria-pressed={excluded}
                        title={
                          excluded
                            ? `Show ${client} replies`
                            : `Hide ${client} replies until refresh`
                        }
                        onClick={() => {
                          setExcludedClients((current) =>
                            current.includes(client)
                              ? current.filter((name) => name !== client)
                              : [...current, client],
                          );
                          setSelected(0);
                        }}
                      >
                        <i
                          style={
                            workspace?.logoUrl
                              ? undefined
                              : {
                                  background:
                                    workspace?.tone || "var(--accent)",
                                }
                          }
                        >
                          {workspace?.logoUrl ? (
                            <img src={workspace.logoUrl} alt="" />
                          ) : (
                            client.slice(0, 1).toUpperCase()
                          )}
                        </i>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="inbox-layout">
            <div
              className="layout-section metrics metrics-section"
              style={
                {
                  order: layoutPrefs.order.indexOf("metrics"),
                  "--metric-count": layoutPrefs.metrics.length,
                } as React.CSSProperties
              }
              hidden={!layoutPrefs.showMetrics}
            >
              {layoutPrefs.metrics.map((metricId) => {
                const metric = metricCatalog.find(
                  (item) => item.id === metricId,
                );
                return metric ? <Metric key={metric.id} {...liveMetric(metric)} /> : null;
              })}
            </div>
            <div
              className="layout-section"
              style={{ order: layoutPrefs.order.indexOf("analytics") }}
              hidden={!layoutPrefs.showAnalytics}
            >
              <InboxAnalytics
                graphs={layoutPrefs.graphs}
                analytics={analytics}
                onChange={(graphs) =>
                  setLayoutPrefs({ ...layoutPrefs, graphs })
                }
              />
            </div>
            <div
              className="layout-section queue-section"
              style={{ order: layoutPrefs.order.indexOf("queue") }}
            >
              <div className="health-strip">
                <div className="health-icon">
                  <Icon name="health" />
                </div>
                <div>
                  <strong>Waiting for synced events</strong>
                  <span>
                    Connect a data source to populate system activity.
                  </span>
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
                    Reply queue{" "}
                    {filtered.length > 0 && <span>{filtered.length}</span>}
                  </h2>
                </div>
                <div className="queue-tools">
                  <label className="search queue-search queue-search-wide">
                    <Icon name="search" />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search leads, companies, campaigns…"
                    />
                  </label>
                  <div className="segmented">
                    {[
                      ["Today", "today"],
                      ["This week", "week"],
                      ["All replies", "All follow-ups"],
                      ["Follow-ups", "follow-ups"],
                    ].map(([label, value]) => (
                      <button
                        key={value}
                        className={filter === value ? "selected" : ""}
                        onClick={() => { setFilter(value); setSelected(0); }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <select
                    className="filter-button"
                    aria-label="Filter by tier"
                    value={["Starred", "Hot", "Warm", "Nurture"].includes(filter) ? filter : ""}
                    onChange={(event) => {
                      setFilter(event.target.value || "All follow-ups");
                      setSelected(0);
                    }}
                  >
                    <option value="">Tier filter</option>
                    <option value="Starred">Starred</option>
                    <option value="Hot">Hot</option>
                    <option value="Warm">Warm</option>
                    <option value="Nurture">Nurture</option>
                  </select>
                  <select
                    className="filter-button"
                    aria-label="Sort conversations"
                    value={sort}
                    onChange={(event) => {
                      setSort(event.target.value);
                      setSelected(0);
                    }}
                  >
                    <option value="score-desc">Sort: Score</option>
                    <option value="newest">Sort: Newest</option>
                    <option value="oldest">Sort: Oldest</option>
                    <option value="name">Sort: Name</option>
                  </select>
                  <div className="heading-actions inbox-actions">
                    <button className="secondary-button">
                      Export <span>↓</span>
                    </button>
                  </div>
                </div>
              </div>
              <div
                ref={paneGridRef}
                className={`dashboard-grid operational-grid ${layoutPrefs.paneSplit < 58 ? "pane-density-no-followup" : ""} ${layoutPrefs.paneSplit < 50 ? "pane-density-no-replies" : ""}`}
                style={
                  {
                    "--inbox-pane": `${layoutPrefs.paneSplit}fr`,
                    "--chat-pane": `${100 - layoutPrefs.paneSplit}fr`,
                  } as React.CSSProperties
                }
              >
                <section className="queue-card inbox-operational-table">
                  <div className={`table-head ${filter === "follow-ups" ? "table-head-followups" : ""}`}>
                    <span>LEAD</span>
                    <span>CLIENT</span>
                    <span>CAMPAIGN</span>
                    <span>LATEST REPLY</span>
                    <span>SENDER</span>
                    <span>REPLIES</span>
                    <span>LEAD SCORE</span>
                    {filter === "follow-ups" && <span>URGENCY</span>}
                  </div>
                  {inboxLoading && (
                    <p className="empty-state">Loading conversations…</p>
                  )}
                  {!inboxLoading && inboxError && (
                    <p className="empty-state error-text">{inboxError}</p>
                  )}
                  {!inboxLoading && !inboxError && filtered.length === 0 && (
                    <p className="empty-state">
                      No conversations have arrived for this inbox yet.
                    </p>
                  )}
                  {visibleLeads.map((lead, index) => (
                    <div
                      className={`lead-row ${selected === index ? "row-selected" : ""} ${lead.sentiment ? `row-sentiment-${lead.sentiment}` : ""}`}
                      key={lead.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelected(index)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(index);
                        }
                      }}
                    >
                      <div className="lead-main">
                        <div
                          className="lead-avatar"
                          style={{ background: lead.photoUrl ? lead.avatar : lead.clientTone }}
                        >
                          <SafeAvatar src={lead.photoUrl} alt={lead.name} fallback={lead.initials} />
                        </div>
                        <div>
                          <strong>{lead.name}</strong>
                          <span>
                            {lead.role} @ {lead.company}
                          </span>
                        </div>
                      </div>
                      <div className="client-cell">
                        <i
                          style={
                            clientLogoFor(lead)
                              ? undefined
                              : { background: lead.clientTone }
                          }
                        >
                          {clientLogoFor(lead) ? (
                            <img src={String(clientLogoFor(lead))} alt="" />
                          ) : (
                            lead.client[0]
                          )}
                        </i>
                        <span>{lead.client}</span>
                      </div>
                      <div className="inbox-meta-cell campaign-cell">
                        <strong>{lead.campaignName || "No campaign"}</strong>
                      </div>
                      <div className="inbox-meta-cell date-cell">
                        <strong>
                          {
                            formatDashboardDateParts(
                              lead.latestReplyAt,
                              appearance.timeZone,
                            ).date
                          }
                        </strong>
                        <span>
                          {
                            formatDashboardDateParts(
                              lead.latestReplyAt,
                              appearance.timeZone,
                            ).time
                          }
                        </span>
                        {lead.sentiment && <span className={`sentiment-badge sentiment-${lead.sentiment}`}>{lead.sentiment}</span>}
                        {filter === "follow-ups" && lead.followUpReason && (
                          <span className="follow-up-reason">{lead.followUpReason}</span>
                        )}
                      </div>
                      <div className="inbox-meta-cell sender-cell">
                        <strong>{lead.senderName}</strong>
                      </div>
                      <div className="inbox-meta-cell turn-cell">
                        <strong>{lead.replies}</strong>
                      </div>
                      <div className="inbox-meta-cell lead-score-cell">
                        <strong>0</strong>
                      </div>
                      {filter === "follow-ups" && (
                        <div className="score-cell follow-up-score-cell">
                          <span className={`score-pill ${(lead.followUpUrgency ?? 0) >= 60 ? "hot" : "warm"}`}>
                            {lead.followUpUrgency ?? 0}
                          </span>
                          <span className="tier-label">urgency</span>
                        </div>
                      )}
                    </div>
                  ))}
                  {filtered.length > visibleLeadCount && (
                    <button
                      className="inbox-see-more"
                      onClick={() => setVisibleLeadCount((count) => count + 10)}
                    >
                      See 10 more
                    </button>
                  )}
                </section>
                <div
                  className="pane-divider"
                  role="separator"
                  aria-label="Resize Inbox and Chat"
                  aria-orientation="vertical"
                  aria-valuemin={40}
                  aria-valuemax={75}
                  aria-valuenow={layoutPrefs.paneSplit}
                  onPointerDown={beginPaneResize}
                >
                  <span />
                </div>
                <aside
                  className={`detail-card ${layoutPrefs.showDetail ? "" : "layout-hidden"}`}
                >
                  <div className="detail-top">
                    <div className="detail-person">
                      <div
                        className="large-avatar"
                        style={{ background: current.avatar }}
                      >
                        <SafeAvatar src={current.photoUrl} alt={current.name} fallback={current.initials} />
                      </div>
                      <div>
                        <div className="detail-name-line">
                          <h3>{current.name}</h3>
                          <button
                            className={`detail-star ${layoutPrefs.starredLeadIds.includes(String(current.leadId || current.id)) ? "is-starred" : ""}`}
                            onClick={() => toggleStar(current)}
                            aria-label={
                              layoutPrefs.starredLeadIds.includes(
                                String(current.leadId || current.id),
                              )
                                ? `Unstar ${current.name}`
                                : `Star ${current.name}`
                            }
                          >
                            ★
                          </button>
                        </div>
                        <p>
                          {current.role} at {current.company}
                        </p>
                        <div className="detail-profile-links">
                          {current.profileUrl && (
                            <a
                              className="linkedin"
                              href={current.profileUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              in&nbsp; LinkedIn profile ↗
                            </a>
                          )}
                          {current.leadId && (
                            <a
                              className="lead-database-link"
                              href={`/database?lead=${encodeURIComponent(current.leadId)}`}
                            >
                              View more →
                            </a>
                          )}
                        </div>
                      </div>
                      {current.companyPhotoUrl && (
                        <img
                          className="enriched-company-logo"
                          src={current.companyPhotoUrl}
                          alt={`${current.company} logo`}
                        />
                      )}
                    </div>
                    <div className="detail-tags">
                      <span className={`score-pill ${current.tier}`}>
                        {current.score} · {current.tier}
                      </span>
                      <span className="tag-outline">{current.client}</span>
                      <span className="tag-outline">{current.senderName}</span>
                      {current.campaignName && (
                        <span className="tag-outline">
                          {current.campaignName}
                        </span>
                      )}
                      <span className="tag-outline">
                        {current.replies} replies
                      </span>
                      {current.sentiment && <span className={`sentiment-badge sentiment-${current.sentiment}`}>{current.sentiment}</span>}
                    </div>
                    {Boolean(current.headline || current.industry) && (
                      <p className="enrichment-summary">
                        {[
                          current.headline,
                          typeof current.industry === "string"
                            ? current.industry
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="reason-box">
                    <span className="reason-icon">✦</span>
                    <div>
                      <small>WHY THIS IS FLAGGED</small>
                      <p>{aiLoading ? "Anthropic is reviewing this conversation…" : aiReason || current.reason}</p>
                    </div>
                  </div>
                  {current.followUpReason && (
                    <div className="reason-box follow-up-reason-box">
                      <span className="reason-icon">⏰</span>
                      <div>
                        <small>FOLLOW-UP RECOMMENDED</small>
                        <p>{current.followUpReason}</p>
                        <small className="follow-up-urgency">Urgency: {current.followUpUrgency ?? 0}/100</small>
                      </div>
                    </div>
                  )}
                  <div className="thread">
                    {current.messages.length ? (
                      current.messages.map((message) => (
                        <div
                          className={`bubble ${message.direction === "outbound" ? "outbound" : "inbound"} ${message.id === latestInboundMessageId ? "latest-inbound" : ""}`}
                          key={message.id}
                        >
                          {message.direction !== "outbound" && (
                            <span>
                              <SafeAvatar src={current.photoUrl} alt={current.name} fallback={current.initials} />
                            </span>
                          )}
                          <small className="message-author">
                            {message.authorName}
                          </small>
                          <p>{message.body}</p>
                          <time>
                            {formatDashboardDate(
                              message.sentAt,
                              appearance.timeZone,
                            )}
                          </time>
                        </div>
                      ))
                    ) : (
                      <p className="empty-state">
                        No conversation messages are available yet.
                      </p>
                    )}
                    <div ref={threadEndRef} />
                  </div>
                  <div className="composer">
                    <div className="composer-top">
                      <span>AI DRAFT</span>
                      <div className="composer-tools">
                        <button type="button" onClick={() => void generateAiReview()} disabled={aiLoading}>{aiLoading ? "Generating…" : "Regenerate ↻"}</button>
                      </div>
                    </div>
                    <textarea
                      value={aiDraft}
                      onChange={(event) => setAiDraft(event.target.value)}
                      placeholder={aiLoading ? "Generating a draft…" : "Anthropic draft will appear here."}
                    />
                    <div className="composer-foot">
                      <span>Beta safety mode · sending disabled</span>
                      <button
                        className="send-button"
                        type="button"
                        disabled
                        title="Sending is disabled during beta testing"
                      >
                        Send reply <span>⌘↵</span>
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
function SafeAvatar({ src, alt, fallback }: { src?: string | null; alt: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img src={src} alt={alt} onError={() => setFailed(true)} /> : <>{fallback}</>;
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
        <div>
          <span>INBOX ANALYTICS</span>
          <h2>Conversation trends</h2>
          <p>
            {analytics?.status === "live"
              ? "Live aggregates from synced conversations and messages."
              : "Analytics will populate after Supabase receives synced HeyReach data."}
          </p>
        </div>
        <div className="graph-builder">
          <select
            value={newPreset}
            onChange={(event) => setNewPreset(Number(event.target.value))}
          >
            {graphPresets.map((preset, index) => (
              <option key={preset.title} value={index}>
                {preset.title}
              </option>
            ))}
          </select>
          <select
            value={newKind}
            onChange={(event) =>
              setNewKind(event.target.value as GraphConfig["kind"])
            }
          >
            <option value="line">Line</option>
            <option value="bars">Bars</option>
            <option value="donut">Donut</option>
          </select>
          <input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="Custom title"
          />
          <button onClick={addGraph} disabled={graphs.length >= 4}>
            + Add graph
          </button>
        </div>
      </div>
      <div className="inbox-graph-grid">
        {graphs.map((graph) => (
          <article className="inbox-graph-card" key={graph.id}>
            <div className="inbox-graph-card-heading">
              <div>
                <span>{graph.metric}</span>
                <strong>{graph.title}</strong>
              </div>
              <button
                aria-label={`Remove ${graph.title}`}
                onClick={() =>
                  onChange(graphs.filter((item) => item.id !== graph.id))
                }
              >
                ×
              </button>
            </div>
            <GraphVisual
              kind={graph.kind}
              metric={graph.metric}
              analytics={analytics}
            />
          </article>
        ))}
      </div>
    </section>
  );
}

function GraphVisual({
  kind,
  metric,
  analytics,
}: {
  kind: GraphConfig["kind"];
  metric: string;
  analytics: AnalyticsSnapshot | null;
}) {
  if (!analytics || analytics.status !== "live")
    return <div className="analytics-empty">No synced data yet</div>;
  if (kind === "donut") {
    const total =
      analytics.queueMix.hot +
      analytics.queueMix.warm +
      analytics.queueMix.nurture;
    const hot = total ? (analytics.queueMix.hot / total) * 100 : 0;
    const warm = total ? hot + (analytics.queueMix.warm / total) * 100 : 0;
    return (
      <div
        className="inbox-donut"
        style={{
          background: `conic-gradient(var(--coral) 0 ${hot}%,var(--amber) ${hot}% ${warm}%,#687080 ${warm}% 100%)`,
        }}
      >
        <div>
          <strong>{total}</strong>
          <small>leads</small>
        </div>
      </div>
    );
  }
  const values =
    metric === "Leads by client"
      ? analytics.clientLoad.map((item) => item.leads)
      : analytics.trend;
  if (kind === "bars") {
    const max = Math.max(...values, 1);
    return (
      <div className="inbox-bars">
        {values.map((value, index) => (
          <i
            key={index}
            style={{ height: `${Math.max(5, (value / max) * 100)}%` }}
          />
        ))}
      </div>
    );
  }
  const max = Math.max(...values, 1);
  const points = values
    .map(
      (value, index) =>
        `${values.length === 1 ? 210 : (index / (values.length - 1)) * 420} ${96 - (value / max) * 82}`,
    )
    .join(" L");
  return values.length ? (
    <svg
      className="inbox-line"
      viewBox="0 0 420 110"
      role="img"
      aria-label="Live trend graph"
    >
      <path d={`M${points}`} />
      <circle
        cx={values.length === 1 ? 210 : 420}
        cy={96 - (values[values.length - 1] / max) * 82}
        r="4"
      />
    </svg>
  ) : (
    <div className="analytics-empty">No synced data yet</div>
  );
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
  const [dragged, setDragged] = useState<
    "metrics" | "analytics" | "queue" | null
  >(null);
  const [draggedMetric, setDraggedMetric] = useState<string | null>(null);
  const labels = {
    metrics: "Summary metrics",
    analytics: "Inbox analytics",
    queue: "Conversation queue",
  };
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
        <div>
          <strong>Inbox layout</strong>
          <small>Drag sections into your preferred order.</small>
        </div>
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
            <span className="drag-handle">⠿</span>
            <strong>{labels[section]}</strong>
            <span className="drag-hint">drag</span>
          </div>
        ))}
      </div>
      <label className="customize-check">
        <input
          type="checkbox"
          checked={prefs.showMetrics}
          onChange={(event) =>
            onChange({ ...prefs, showMetrics: event.target.checked })
          }
        />{" "}
        Show summary metrics
      </label>
      <label className="customize-check">
        <input
          type="checkbox"
          checked={prefs.showAnalytics}
          onChange={(event) =>
            onChange({ ...prefs, showAnalytics: event.target.checked })
          }
        />{" "}
        Show inbox analytics
      </label>
      <label className="customize-check">
        <input
          type="checkbox"
          checked={prefs.showDetail}
          onChange={(event) =>
            onChange({ ...prefs, showDetail: event.target.checked })
          }
        />{" "}
        Show conversation detail
      </label>
      <label className="customize-check">
        <input
          type="checkbox"
          checked={prefs.compact}
          onChange={(event) =>
            onChange({ ...prefs, compact: event.target.checked })
          }
        />{" "}
        Compact spacing
      </label>
      <div className="metric-picker-heading">
        <strong>Summary metrics</strong>
        <small>{prefs.metrics.length}/6 selected</small>
      </div>
      <div className="metric-picker">
        {[
          ...prefs.metrics,
          ...metricCatalog
            .map((metric) => metric.id)
            .filter((id) => !prefs.metrics.includes(id)),
        ].map((metricId) => {
          const metric = metricCatalog.find((item) => item.id === metricId)!;
          const checked = prefs.metrics.includes(metric.id);
          return (
            <div
              className="metric-picker-row"
              key={metric.id}
              draggable={checked}
              onDragStart={() => checked && setDraggedMetric(metric.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => moveMetric(metric.id)}
            >
              <span className="drag-handle">⠿</span>
              <label className="customize-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && prefs.metrics.length >= 6}
                  onChange={() =>
                    onChange({
                      ...prefs,
                      metrics: checked
                        ? prefs.metrics.filter((id) => id !== metric.id)
                        : [...prefs.metrics, metric.id],
                    })
                  }
                />{" "}
                {metric.label}
              </label>
            </div>
          );
        })}
      </div>
      <button className="customize-save" onClick={onSave}>
        Save layout
      </button>
    </div>
  );
}
