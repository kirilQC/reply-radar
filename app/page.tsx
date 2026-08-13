"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DashboardHome from "./components/DashboardHome";
import AppSidebar from "./components/AppSidebar";
import Crumb from "./components/Crumb";
import { usePopoverDismiss } from "./lib/use-popover-dismiss";
import AppearancePanel, {
  type AppearancePrefs,
} from "./components/AppearancePanel";
import {
  identityKey,
  layoutKey,
  layoutStorageKey,
  readCachedAppearance,
  setActiveProfile,
  writeCachedAppearance,
} from "./lib/preference-identity";

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
  icpReason?: string | null;
  followUpScore?: number;
  followUpAnalyzedAt?: string | null;
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
  cachedDraft?: string | null;
  cachedReason?: string | null;
  analyzedAt?: string | null;
  followUpUrgency?: number;
  followUpReason?: string | null;
  lastMessageAt?: string | null;
  latestReplyAt?: string | null;
  lastRefreshedAt?: string | null;
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
  /** Which generation of the stock graphs this layout was last written against. */
  defaultsRevision?: number;
};
type GraphKind = "line" | "area" | "bars" | "hbars" | "donut";
/** A graph is a dimension (x) crossed with a measure (y) — both are user-selectable. */
type GraphConfig = {
  id: string;
  title: string;
  x: string;
  y: string;
  kind: GraphKind;
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
/**
 * Bumped whenever the stock graphs change and every inbox is meant to get them, including
 * ones somebody had already customised. A saved layout carries the revision it was written
 * against, so the reset below happens exactly once per inbox and later edits stand.
 */
const layoutDefaultsRevision = 2;
const defaultLayout: LayoutPrefs = {
  order: ["metrics", "queue", "analytics"],
  showMetrics: true,
  showAnalytics: true,
  showDetail: true,
  compact: false,
  metrics: ["totalReplies", "needsReply", "acceptanceRate", "avgRepliesCampaign", "positiveRate"],
  // Every inbox opens on these two until someone changes them.
  graphs: [
    { id: "replies-by-day", title: "Reply volume", x: "day", y: "replies", kind: "area" },
    { id: "replies-by-campaign", title: "Replies by campaign", x: "campaign", y: "replies", kind: "bars" },
  ],
  paneSplit: 62,
  starredLeadIds: [],
  defaultsRevision: layoutDefaultsRevision,
};
const applyGraphDefaults = (layout: LayoutPrefs): LayoutPrefs =>
  layout.defaultsRevision === layoutDefaultsRevision
    ? layout
    : { ...layout, graphs: defaultLayout.graphs };
const clientCampaignMetricIds = [
  "totalReplies",
  "acceptanceRate",
  "avgRepliesCampaign",
  "positiveRate",
  "needsReply",
];
const defaultAppearance: AppearancePrefs = {
  mode: "midnight",
  zoom: 100,
  font: "Inter, ui-sans-serif, system-ui, sans-serif",
  background: "#0b0c10",
  accent: "#8b7cff",
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
    id: "needsReply",
    label: "Needs reply",
    value: "—",
    delta: "",
    tone: "coral",
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
    label: "Replies",
    value: "—",
    delta: "",
    tone: "green",
    sub: "Awaiting synced data",
  },
  {
    id: "positiveRate",
    label: "Positive reply rate",
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
const DEFAULT_FOLLOW_UP_THRESHOLD = 50;
/**
 * How long a synced conversation counts as fresh.
 *
 * Opening an inbox refreshes the visible rows against HeyReach, which is a round trip per
 * conversation. People move between client inboxes constantly, and the old window was sixty
 * seconds, so most of those trips were re-fetching a conversation someone had just fetched.
 * Fifteen minutes is well inside the time it takes anyone to work a queue, and the window is
 * measured against the server's own `last_refreshed_at`, so it holds across reloads and tabs.
 */
const REFRESH_WINDOW_MS = 15 * 60_000;
const followUpBand = (score: number): "hot" | "warm" | "cold" | "nurture" => {
  if (score >= 75) return "hot";
  if (score >= 50) return "warm";
  if (score >= 25) return "cold";
  return "nurture";
};
/**
 * Fold a fresh inbox payload over the list already on screen.
 *
 * A plain replace would discard AI results that were merged in client-side but whose
 * database write has not been read back yet, making scores and drafts appear to reset.
 */
const mergeInboxLeads = (previous: Lead[], incoming: Lead[]): Lead[] => {
  if (!previous.length) return incoming;
  const byId = new Map(previous.map((lead) => [lead.id, lead]));
  return incoming.map((lead) => {
    const old = byId.get(lead.id);
    if (!old) return lead;
    const merged: Lead = { ...lead };
    if (!merged.sentiment && old.sentiment) merged.sentiment = old.sentiment;
    if (!merged.analyzedAt && old.analyzedAt) {
      merged.analyzedAt = old.analyzedAt;
      merged.cachedDraft = old.cachedDraft;
      merged.cachedReason = old.cachedReason;
    }
    if ((merged.leadScore === null || merged.leadScore === undefined) && old.leadScore !== null && old.leadScore !== undefined) {
      merged.leadScore = old.leadScore;
      merged.icpReason = old.icpReason;
    }
    if (!merged.followUpAnalyzedAt && old.followUpAnalyzedAt) {
      merged.followUpAnalyzedAt = old.followUpAnalyzedAt;
      merged.followUpUrgency = old.followUpUrgency;
      merged.followUpReason = old.followUpReason;
    }
    return merged;
  });
};
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
  // Selection is tracked by conversation id, not list index: AI scores arriving in the
  // background re-sort `filtered`, and an index would silently point at a different lead
  // (which then triggered another round of paid AI calls, and another re-sort).
  const [selectedId, setSelectedId] = useState(""),
    [activeNav, setActiveNav] = useState("inbox"),
    [filter, setFilter] = useState("today"),
    [sort, setSort] = useState("score-desc"),
    [search, setSearch] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [theme, setTheme] = useState("midnight"),
    [sidebarOpen, setSidebarOpen] = useState(false);
  const [layoutPrefs, setLayoutPrefs] = useState(defaultLayout);
  const [appearance, setAppearance] = useState(defaultAppearance);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
  const [filterSub, setFilterSub] = useState<string | null>(null);
  const [campaignFilter, setCampaignFilter] = useState("");
  const [senderFilter, setSenderFilter] = useState("");
  const [sentimentFilter, setSentimentFilter] = useState("");
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const leadsRef = useRef<Lead[]>([]);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [inboxError, setInboxError] = useState("");
  const [queryString, setQueryString] = useState("");
  const [excludedClients, setExcludedClients] = useState<string[]>([]);
  const [visibleLeadCount, setVisibleLeadCount] = useState(10);
  const [messagingDocUrl, setMessagingDocUrl] = useState("");
  const [quickTemplates, setQuickTemplates] = useState<QuickTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // Templates save themselves as they are added, so clicking away just closes the notepad.
  const notepadRef = usePopoverDismiss<HTMLDivElement>(() =>
    setTemplatesOpen(false),
  );
  const [templateDraft, setTemplateDraft] = useState({ name: "", value: "" });
  const [aiDraft, setAiDraft] = useState("");
  // An already-answered conversation hides the composer, because the usual next move is to wait.
  // Sometimes it isn't — a nudge is overdue — so the "replied to" line opens the box on click.
  const [composeAnyway, setComposeAnyway] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [inboxSyncing, setInboxSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState({ done: 0, total: 0 });
  const syncPercent = syncProgress.total
    ? Math.round((syncProgress.done / syncProgress.total) * 100)
    : 0;
  const [lastInboxSync, setLastInboxSync] = useState<string>("");
  const [toastMessage, setToastMessage] = useState("");
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * When this tab last *asked* about a conversation, id → epoch ms.
   *
   * `last_refreshed_at` on the row answers "is this fresh" for everything that syncs cleanly.
   * This covers what it cannot: a conversation the server declines to stamp — a workspace with no
   * HeyReach key, a lead with no account id, HeyReach unreachable — is never fresh, so it would be
   * re-attempted every time the visible set changed. Timestamps rather than a plain set, so
   * nothing is skipped permanently: once the window lapses it is tried again like anything else.
   */
  const refreshAttemptsRef = useRef(new Map<string, number>());
  const [workspaceAi, setWorkspaceAi] = useState({ model: "", brief: "", systemPrompt: "", id: "", icpPrompt: "", followUpPrompt: "", followUpThreshold: DEFAULT_FOLLOW_UP_THRESHOLD });
  const followUpThreshold = workspaceAi.followUpThreshold ?? DEFAULT_FOLLOW_UP_THRESHOLD;
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(""), 4000);
  };
  const refreshConversation = async (convId: string) => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/conversations/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: convId }) });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.results?.[0]) {
        const result = data.results[0];
        const thread = Array.isArray(result.thread) ? result.thread : null;
        const newMessages = result.newMessages ?? 0;
        // Update only this conversation's messages in-place
        if (thread) {
          setLeads((prev) => prev.map((lead) =>
            lead.id === convId
              ? { ...lead, messages: thread, lastRefreshedAt: result.lastRefreshedAt ?? new Date().toISOString() }
              : lead,
          ));
        }
        showToast(newMessages > 0 ? `${newMessages} new message${newMessages === 1 ? "" : "s"} found` : "Conversation up to date");
        // Re-analyze if new messages were found (force regeneration)
        if (newMessages > 0) {
          // A new reply invalidates the follow-up score, so let it be requested again.
          scoredRef.current.followUp.delete(convId);
          setLeads((prev) => prev.map((lead) =>
            lead.id === convId ? { ...lead, followUpAnalyzedAt: null } : lead,
          ));
          void generateAiReview(workspaceAi, true);
        }
      }
    } catch { /* ignore */ }
    setRefreshing(false);
  };
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
        .catch(() => null)
        // Flip this regardless of the outcome: the inbox waits for the directory to
        // settle, and a failed lookup must not leave it waiting forever.
        .finally(() => setDirectoryLoaded(true));
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
  // The thing being looked at. Layout is remembered per scope (a client's section order and
  // pane split are that client's, not everyone's); appearance is not scoped at all.
  const layoutScope = profileParam
    ? `profile:${profileParam}`
    : clientParam
      ? `client:${clientParam}`
      : "general";
  // Arriving as a profile is the closest thing to signing in, so it is remembered: the accent
  // picked here still applies on /reports, and a teammate on their own profile keeps theirs.
  useEffect(() => {
    if (profileParam) setActiveProfile(profileParam);
  }, [profileParam]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const savedLayout = window.localStorage.getItem(
          layoutStorageKey(layoutScope),
        );
        // Pre-identity saves lived under one key per scope and held both halves.
        const legacy = window.localStorage.getItem(
          `reply-radar-prefs:${layoutScope}`,
        );
        const parsed = {
          layout:
            JSON.parse(savedLayout || "null")?.layout ??
            JSON.parse(legacy || "null")?.layout,
          appearance: readCachedAppearance(),
        };
        if (parsed?.layout) {
          const nextLayout = { ...defaultLayout, ...parsed.layout };
          nextLayout.starredLeadIds = Array.isArray(nextLayout.starredLeadIds)
            ? nextLayout.starredLeadIds.map(String)
            : [];
          nextLayout.graphs = normalizeGraphs(nextLayout.graphs);
          nextLayout.order = Array.from(
            new Set([...nextLayout.order, "metrics", "analytics", "queue"]),
          ).filter((item) =>
            ["metrics", "analytics", "queue"].includes(item),
          ) as LayoutPrefs["order"];
          if (clientParam) nextLayout.metrics = clientCampaignMetricIds;
          setLayoutPrefs(applyGraphDefaults(nextLayout));
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
  }, [layoutScope]);
  useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/preferences?identity=${encodeURIComponent(identityKey())}&scope=${encodeURIComponent(layoutKey(layoutScope))}&legacy=${encodeURIComponent(layoutScope)}`,
      {
        cache: "no-store",
      },
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled || !payload?.preferences) return;
        if (payload.preferences.layout)
          setLayoutPrefs((current) =>
            applyGraphDefaults({
              ...current,
              ...payload.preferences.layout,
              ...(clientParam ? { metrics: clientCampaignMetricIds } : {}),
              starredLeadIds: Array.isArray(
                payload.preferences.layout.starredLeadIds,
              )
                ? payload.preferences.layout.starredLeadIds.map(String)
                : current.starredLeadIds,
              graphs: normalizeGraphs(payload.preferences.layout.graphs),
              // Read off the stored row rather than inherited from `current`, which the
              // local-cache pass above may already have stamped.
              defaultsRevision:
                Number(payload.preferences.layout.defaultsRevision) || 0,
            }),
          );
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
  }, [layoutScope]);
  useEffect(() => {
    // Wait for the workspace directory: firing early sends an empty slug list, which the
    // API reads as "every client" and costs a full second round trip a moment later.
    if (!directoryLoaded) return;
    let cancelled = false;
    fetch(`/api/analytics?workspaces=${encodeURIComponent(trackedWorkspaceSlugs.join(","))}`, {
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
  }, [directoryLoaded, trackedClients.join(",")]);
  useEffect(() => {
    if (!directoryLoaded) return;
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
        const incoming: Lead[] = Array.isArray(payload.conversations)
          ? payload.conversations
          : [];
        setLeads((previous) => mergeInboxLeads(previous, incoming));
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
  }, [directoryLoaded, trackedWorkspaceSlugs.join(",")]);
  useEffect(() => {
    leadsRef.current = leads;
  }, [leads]);
  // Poll for sentiment updates every 15s — keeps the UI feeling alive.
  // Reads the live list through a ref: keying the effect on the joined id list meant the
  // closure went stale the moment a sentiment landed, so it re-requested the same
  // conversations forever instead of draining the queue.
  useEffect(() => {
    if (!leads.length) return;
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      const pending = leadsRef.current.filter((lead) => !lead.sentiment).map((lead) => lead.id);
      if (!pending.length) return;
      try {
        const res = await fetch("/api/conversations/sentiment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationIds: pending }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled || !data.ok || !data.sentiments) return;
        const updates = data.sentiments as Record<string, string | null>;
        if (!Object.values(updates).some(Boolean)) return;
        setLeads((prev) => prev.map((lead) => {
          const next = updates[lead.id];
          return next && !lead.sentiment ? { ...lead, sentiment: next } : lead;
        }));
      } catch { /* ignore */ }
    };
    const interval = setInterval(poll, 15_000);
    // Run once immediately for fast first paint
    void poll();
    return () => { cancelled = true; clearInterval(interval); };
  }, [leads.length > 0]);
  const savePreferences = (
    nextLayout = layoutPrefs,
    nextAppearance = appearance,
  ) => {
    const payload = { layout: nextLayout, appearance: nextAppearance };
    window.localStorage.setItem(
      layoutStorageKey(layoutScope),
      JSON.stringify({ layout: nextLayout }),
    );
    // Appearance is stored once, without a scope, because it applies to the whole site.
    writeCachedAppearance(nextAppearance);
    // Apply the same settings to the document immediately so they remain global
    // while navigating between routes (not just on the inbox's local <main>).
    const root = document.documentElement;
    root.style.setProperty("--accent", nextAppearance.accent);
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
      body: JSON.stringify({
        identity: identityKey(),
        scope: layoutKey(layoutScope),
        preferences: payload,
      }),
    }).catch(() => undefined);
    // Other routes mount their own appearance applier; this tells them to re-read.
    window.dispatchEvent(
      new CustomEvent("reply-radar-appearance-changed", {
        detail: nextAppearance,
      }),
    );
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
            // The placeholder promises campaigns, so search them — plus the role
            // and the sender, which is how people actually look a reply up.
            (!search ||
              `${lead.name} ${lead.company} ${lead.client} ${lead.campaignName ?? ""} ${lead.senderName} ${lead.role}`
                .toLowerCase()
                .includes(search.trim().toLowerCase())) &&
            (!assignedClients || assignedClients.includes(lead.client)) &&
            !excludedClients.includes(lead.client) &&
            (!campaignFilter || lead.campaignName === campaignFilter) &&
            (!senderFilter || lead.senderName === senderFilter) &&
            (!sentimentFilter || lead.sentiment === sentimentFilter) &&
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
    // assignedClients / excludedClients are rebuilt every render, so key on their
    // contents — otherwise this memo never actually memoizes and the whole list
    // re-sorts on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      leads,
      search,
      filter,
      sort,
      assignedClients?.join("|") ?? "",
      excludedClients.join("|"),
      layoutPrefs.starredLeadIds.join("|"),
      campaignFilter,
      senderFilter,
      sentimentFilter,
    ],
  );
  useEffect(() => {
    setVisibleLeadCount(10);
    setSelectedId("");
  }, [filter, search, sort, clientParam, profileParam]);
  const visibleLeads = filtered.slice(0, visibleLeadCount);
  // Keep the rows on the screen — and the "already-replied" check next to each
  // name — accurate against HeyReach. Scoped to what the user can actually see
  // (up to /api/conversations/refresh's cap of 50 IDs) and gated by the
  // freshness window below. A global inbox poll was rejected because this page
  // will run at high volume across dozens of clients; the freshness signal
  // lives per-conversation ("Last synced X @ Y" in the drawer) rather than as a
  // background refetch loop.
  const visibleIdsKey = visibleLeads.map((lead) => lead.id).join(",");
  useEffect(() => {
    if (!visibleIdsKey) return;
    const now = Date.now();
    const cutoff = now - REFRESH_WINDOW_MS;
    const attempts = refreshAttemptsRef.current;
    const staleIds = visibleLeads
      .filter((lead) => {
        // What the server last recorded. Durable, so hopping between two inboxes,
        // or reloading the page, does not re-sync what was just synced.
        const stampedAt = lead.lastRefreshedAt
          ? Date.parse(lead.lastRefreshedAt)
          : 0;
        if (stampedAt && stampedAt >= cutoff) return false;
        // And what this tab has already asked about, which covers the conversations
        // the server cannot stamp — no HeyReach key, no account id, HeyReach down.
        // Without this they would be retried on every filter click.
        return (attempts.get(lead.id) ?? 0) < cutoff;
      })
      .map((lead) => lead.id)
      .slice(0, 50);
    if (!staleIds.length) return;
    let cancelled = false;
    setInboxSyncing(true);
    setSyncProgress({ done: 0, total: staleIds.length });
    (async () => {
      // Refreshed in small batches rather than one 50-conversation request, so the
      // progress bar is measuring real work: each batch that lands moves the bar and
      // updates its rows immediately, instead of the whole inbox arriving at once.
      const BATCH_SIZE = 5;
      try {
        for (let offset = 0; offset < staleIds.length; offset += BATCH_SIZE) {
          if (cancelled) return;
          const batch = staleIds.slice(offset, offset + BATCH_SIZE);
          // Marked as the batch goes out, not up front: if the user switches inbox
          // mid-sync the batches that never left are still eligible next time.
          for (const id of batch) attempts.set(id, Date.now());
          try {
            const response = await fetch("/api/conversations/refresh", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ conversationIds: batch }),
            });
            const data = (await response.json().catch(() => null)) as
              | {
                  ok?: boolean;
                  results?: Array<{
                    id?: string;
                    thread?: unknown;
                    lastRefreshedAt?: string;
                  }>;
                }
              | null;
            if (cancelled) return;
            if (data?.ok && Array.isArray(data.results)) {
              const nowIso = new Date().toISOString();
              const updates = new Map<
                string,
                { thread: Lead["messages"]; lastRefreshedAt: string }
              >();
              for (const result of data.results) {
                if (
                  result &&
                  typeof result.id === "string" &&
                  Array.isArray(result.thread)
                ) {
                  updates.set(result.id, {
                    thread: result.thread as Lead["messages"],
                    lastRefreshedAt: result.lastRefreshedAt ?? nowIso,
                  });
                }
              }
              if (updates.size) {
                setLeads((prev) =>
                  prev.map((lead) => {
                    const update = updates.get(lead.id);
                    if (!update) return lead;
                    return {
                      ...lead,
                      messages: update.thread,
                      lastRefreshedAt: update.lastRefreshedAt,
                    };
                  }),
                );
              }
            }
          } catch {
            /* one bad batch shouldn't stop the rest of the sync */
          }
          if (cancelled) return;
          setSyncProgress({
            done: Math.min(offset + batch.length, staleIds.length),
            total: staleIds.length,
          });
        }
      } finally {
        if (!cancelled) {
          setInboxSyncing(false);
          setLastInboxSync(new Date().toISOString());
        }
      }
    })();
    return () => {
      cancelled = true;
      setInboxSyncing(false);
    };
    // visibleIdsKey stands in for the visible-lead set; including visibleLeads
    // itself would refire on every setLeads and cause an inbox-wide loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey]);
  // Names the range the charts are actually drawn over, so a reader can tell at a
  // glance whether a flat line means a quiet day or a quiet quarter.
  const analyticsRangeLabel =
    filter === "today"
      ? "Today"
      : filter === "week"
        ? "This week"
        : filter === "follow-ups"
          ? "Replies needing follow-up · all time"
          : filter === "Starred"
            ? "Starred replies · all time"
            : ["Hot", "Warm", "Nurture"].includes(filter)
              ? `${filter} replies · all time`
              : "All replies · all time";
  const liveMetric = (metric: (typeof metricCatalog)[number]) => {
    const averages = analytics?.campaignAverages;
    const filterLabel = filter === "today" ? "today" : filter === "week" ? "this week" : filter === "follow-ups" ? "needing follow-up" : "total";
    // The card headings name the range in plain English; "total" reads as a count.
    const rangeWord = filterLabel === "total" ? "all time" : filterLabel;
    const positiveCount = filtered.filter((l) => l.sentiment === "positive").length;
    const negativeCount = filtered.filter((l) => l.sentiment === "negative").length;
    const totalReplies = filtered.reduce((sum, l) => sum + l.replies, 0);
    const positiveRate = filtered.length ? ((positiveCount / filtered.length) * 100).toFixed(1) : "0.0";
    // Leads awaiting our reply — last message from them, not from us. Uses `filtered`
    // so the count matches the inbox view the user is currently looking at.
    const needsReplyCount = filtered.filter((l) => l.messages.at(-1)?.direction === "inbound").length;
    const values: Record<string, { value: string; sub: string; label?: string }> = {
      needsAction: { value: String(filtered.length), sub: `Conversations ${filterLabel}` },
      hotConversations: { value: String(positiveCount), sub: `Positive replies ${filterLabel}` },
      pipelineSaved: { value: String(negativeCount), sub: `Negative replies ${filterLabel}` },
      replyCount7d: { value: String(totalReplies), sub: `Replies ${filterLabel}` },
      totalReplies: { value: String(totalReplies), label: `Replies ${rangeWord}`, sub: `Replies ${filterLabel}` },
      positiveRate: { value: `${positiveRate}%`, label: `Positive reply rate ${rangeWord}`, sub: `From our sentiment analysis · ${filterLabel}` },
      avgRepliesCampaign: { value: averages ? `${averages.replyRate.toFixed(1)}%` : "—", label: "Average reply rate", sub: "Average across campaigns" },
      acceptanceRate: { value: averages ? `${averages.acceptanceRate.toFixed(1)}%` : "—", label: "Average acceptance rate", sub: "Average across campaigns" },
      needsReply: { value: String(needsReplyCount), sub: `Leads waiting on us · ${filterLabel}`, label: `Number of leads needing reply ${rangeWord}` },
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
  const current: Lead = filtered.find((lead) => lead.id === selectedId) ?? filtered[0] ?? {
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
  // The conversation currently on screen. In-flight AI calls compare against this before
  // writing to the draft pane, so a slow response cannot land on a different lead.
  const activeConversationRef = useRef(current.id);
  // Ids already sent for scoring this session — see the ICP/follow-up effect below.
  const scoredRef = useRef({ icp: new Set<string>(), followUp: new Set<string>() });
  useEffect(() => {
    activeConversationRef.current = current.id;
    setComposeAnyway(false);
  }, [current.id]);
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
  const generateAiReview = async (ai = workspaceAi, forceRegenerate = false) => {
    if (!current.messages.length || current.id === "empty") return;
    const conversationId = current.id;
    // Check for cached data: use it if the latest inbound message hasn't changed since analysis
    if (!forceRegenerate && current.cachedDraft && current.analyzedAt) {
      const latestInbound = [...current.messages].reverse().find((m) => m.direction !== "outbound");
      const latestInboundTime = latestInbound ? new Date(latestInbound.sentAt).getTime() : 0;
      const analyzedTime = new Date(current.analyzedAt).getTime();
      if (analyzedTime > latestInboundTime) {
        setAiDraft(current.cachedDraft);
        return;
      }
    }
    setAiLoading(true);
    const response = await fetch("/api/ai/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "analyze", model: ai.model || undefined, system: ai.systemPrompt || undefined, conversationId, workspaceId: ai.id || selectedWorkspaceSlug, workspaceName: current.client, leadName: current.name, campaignName: current.campaignName || undefined, thread: current.messages, regenerate: forceRegenerate, instruction: ai.brief ? `Client context: ${ai.brief}` : "" }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    if (response?.ok) {
      const draft = String(payload.draft ?? "");
      const reason = String(payload.reason ?? "This lead sent a new reply that is ready for review.");
      // Cache against the lead this request was for, whatever is selected now.
      const newSentiment = String(payload.sentiment ?? "").toLowerCase();
      const now = new Date().toISOString();
      setLeads((prev) => prev.map((lead) =>
        lead.id === conversationId ? { ...lead, sentiment: ["positive", "neutral", "negative"].includes(newSentiment) ? newSentiment : lead.sentiment, cachedDraft: draft, cachedReason: reason, analyzedAt: now } : lead,
      ));
      // The user may have moved on while this was in flight; the newer request owns the pane.
      if (activeConversationRef.current !== conversationId) return;
      setAiDraft(draft);
    } else {
      if (activeConversationRef.current !== conversationId) return;
      setAiDraft("");
    }
    setAiLoading(false);
  };
  // Sentiment is scored once, when the reply lands, and then never revisited — which is the right
  // default until the classification rules change, at which point the stored verdict is an old
  // opinion nothing would otherwise correct. Clicking the badge asks for today's answer.
  const [sentimentBusy, setSentimentBusy] = useState(false);
  const rescoreSentiment = async () => {
    if (sentimentBusy || current.id === "empty") return;
    const conversationId = current.id;
    setSentimentBusy(true);
    const response = await fetch("/api/conversations/sentiment/rescore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, workspaceId: workspaceAi.id || selectedWorkspaceSlug, workspaceName: current.client, leadName: current.name }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    if (response?.ok && payload?.sentiment) {
      setLeads((prev) => prev.map((lead) => (lead.id === conversationId ? { ...lead, sentiment: String(payload.sentiment) } : lead)));
    }
    setSentimentBusy(false);
  };
  useEffect(() => {
    setAiDraft("");
    setTemplatesOpen(false);
    if (!selectedWorkspaceSlug) { setMessagingDocUrl(""); setQuickTemplates([]); setWorkspaceAi({ model: "", brief: "", systemPrompt: "", id: "", icpPrompt: "", followUpPrompt: "", followUpThreshold: DEFAULT_FOLLOW_UP_THRESHOLD }); return; }
    let cancelled = false;
    const conversationId = current.id;
    const leadId = current.leadId;
    fetch(`/api/client-resources?workspace=${encodeURIComponent(selectedWorkspaceSlug)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (cancelled || !payload?.workspace) return;
        setMessagingDocUrl(String(payload.workspace.messagingDocUrl ?? ""));
        setQuickTemplates(Array.isArray(payload.workspace.quickTemplates) ? payload.workspace.quickTemplates : []);
        const ai = { model: String(payload.workspace.model ?? ""), brief: String(payload.workspace.brief ?? ""), systemPrompt: String(payload.workspace.systemPrompt ?? ""), id: String(payload.workspace.id ?? ""), icpPrompt: String(payload.workspace.icpPrompt ?? ""), followUpPrompt: String(payload.workspace.followUpPrompt ?? ""), followUpThreshold: Number(payload.workspace.followUpThreshold ?? DEFAULT_FOLLOW_UP_THRESHOLD) };
        setWorkspaceAi(ai);
        void generateAiReview(ai);
        // ICP score: scored once per lead and stored on the lead forever.
        // scoredRef is the hard stop — every one of these is a billed call, so a lead is
        // never scored twice in a session even if the list re-sorts under the selection.
        if (leadId && (current.leadScore === null || current.leadScore === undefined) && !scoredRef.current.icp.has(leadId)) {
          scoredRef.current.icp.add(leadId);
          void fetch("/api/ai/icp-score", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leadId, workspaceId: ai.id || selectedWorkspaceSlug, workspaceName: current.client, leadName: current.name, icpPrompt: ai.icpPrompt, clientBrief: ai.brief }) })
            .then((r) => r.json())
            .then((d) => { if (d.ok) setLeads((prev) => prev.map((l) => l.id === conversationId ? { ...l, leadScore: d.icpScore, icpReason: d.icpReason } : l)); })
            .catch(() => null);
        }
        // Follow-up score: cached against the latest reply, so it only recomputes on a new reply.
        if (current.messages.length && !current.followUpAnalyzedAt && !scoredRef.current.followUp.has(conversationId)) {
          scoredRef.current.followUp.add(conversationId);
          void fetch("/api/ai/follow-up-score", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId, workspaceId: ai.id || selectedWorkspaceSlug, workspaceName: current.client, leadName: current.name, followUpPrompt: ai.followUpPrompt, sentiment: current.sentiment, thread: current.messages }) })
            .then((r) => r.json())
            .then((d) => {
              if (!d.ok) return;
              // Only claim the score is cached when the database actually took the write,
              // otherwise the UI hides a value that will not survive a reload.
              const stored = d.cached === true || d.persisted === true;
              setLeads((prev) => prev.map((l) => l.id === conversationId
                ? { ...l, followUpUrgency: d.urgency, followUpReason: d.reason, followUpAnalyzedAt: stored ? new Date().toISOString() : l.followUpAnalyzedAt ?? null }
                : l));
            })
            .catch(() => null);
        }
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
          // The saved background is a dark plate (every preset is), and setting it
          // inline here beat the --bg that .light-mode redefines on this same
          // element — which is why light mode kept painting a dark page. Light mode
          // owns its own surface.
          ...(theme === "light" ? {} : { "--bg": appearance.background }),
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
          <Crumb
            trail={[
              { label: "Inbox", href: "/inbox" },
              { label: profileName ?? (clientParam ? clientName : "General inbox") },
            ]}
          />
          <div className="top-actions">
            {messagingDocUrl && (
              <a className="icon-button messaging-doc-shortcut" href={messagingDocUrl} target="_blank" rel="noreferrer" aria-label="Open client messaging document" title="Open client messaging document">▤</a>
            )}
            <div className="notepad-dropdown-wrap">
              <button
                className="icon-button notepad-toggle"
                data-popover-toggle
                aria-label="Quick templates notepad"
                title="Quick templates notepad"
                onClick={() => setTemplatesOpen((open) => !open)}
              >
                ≡
              </button>
              {templatesOpen && (
                <div className="notepad-dropdown" ref={notepadRef}>
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
              data-popover-toggle
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
              data-popover-toggle
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
                          setSelectedId("");
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
                leads={filtered}
                filterLabel={analyticsRangeLabel}
                timeZone={appearance.timeZone}
                loading={inboxLoading}
                onChange={(graphs) => {
                  // Touching the graphs opts this inbox out of the defaults reset, so it has
                  // to be written now — otherwise the next load would undo the edit.
                  const next = {
                    ...layoutPrefs,
                    graphs,
                    defaultsRevision: layoutDefaultsRevision,
                  };
                  setLayoutPrefs(next);
                  savePreferences(next, appearance);
                }}
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
                  {/* Collapsed to its icon so the filter row has room to breathe.
                      A live query keeps it open, so results never disappear
                      behind a button the user has to remember to press. */}
                  <div
                    className={`queue-search-shell ${searchOpen || search ? "is-open" : ""}`}
                  >
                    <button
                      type="button"
                      className="queue-search-toggle"
                      aria-label={
                        searchOpen || search ? "Clear and close search" : "Search replies"
                      }
                      aria-expanded={searchOpen || Boolean(search)}
                      onClick={() => {
                        if (searchOpen || search) {
                          setSearch("");
                          setSearchOpen(false);
                          return;
                        }
                        setSearchOpen(true);
                        requestAnimationFrame(() => searchInputRef.current?.focus());
                      }}
                    >
                      <Icon name="search" />
                    </button>
                    <input
                      ref={searchInputRef}
                      className="queue-search-input"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      onBlur={() => {
                        if (!search) setSearchOpen(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setSearch("");
                          setSearchOpen(false);
                        }
                      }}
                      placeholder="Search leads, companies, campaigns…"
                      aria-label="Search replies"
                      tabIndex={searchOpen || search ? 0 : -1}
                    />
                  </div>
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
                        onClick={() => { setFilter(value); setSelectedId(""); }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="unified-filter-wrap">
                    <button className="filter-button unified-filter-toggle" onClick={() => { setFilterDropdownOpen((v) => !v); setFilterSub(null); }}>
                        Filters{(campaignFilter || senderFilter || sentimentFilter || sort !== "score-desc" || ["Starred", "Hot", "Warm", "Nurture"].includes(filter)) ? " ●" : ""}
                      </button>
                      {filterDropdownOpen && (
                        <div className="unified-filter-dropdown">
                          <button className={`uf-item ${filter === "Starred" ? "uf-active" : ""}`} onMouseEnter={() => setFilterSub(null)} onClick={() => { setFilter(filter === "Starred" ? "All follow-ups" : "Starred"); setSelectedId(""); }}>Starred {filter === "Starred" ? "✓" : ""}</button>
                          <button className="uf-item" onMouseEnter={() => setFilterSub("campaign")}>Campaign {campaignFilter ? `· ${campaignFilter.slice(0, 20)}` : ""}<b>›</b></button>
                          <button className="uf-item" onMouseEnter={() => setFilterSub("sender")}>Sender {senderFilter ? `· ${senderFilter.slice(0, 20)}` : ""}<b>›</b></button>
                          <button className="uf-item" onMouseEnter={() => setFilterSub("sentiment")}>Sentiment {sentimentFilter ? `· ${sentimentFilter}` : ""}<b>›</b></button>
                          <button className="uf-item" onMouseEnter={() => setFilterSub("tier")}>Tier {["Hot", "Warm", "Nurture"].includes(filter) ? `· ${filter}` : ""}<b>›</b></button>
                          <button className="uf-item" onMouseEnter={() => setFilterSub("sort")}>Sort {sort !== "score-desc" ? `· ${sort}` : ""}<b>›</b></button>
                          <div className="uf-divider" />
                          <button className="uf-item uf-clear" onClick={() => { setCampaignFilter(""); setSenderFilter(""); setSentimentFilter(""); setSort("score-desc"); setFilter("All follow-ups"); setFilterDropdownOpen(false); setSelectedId(""); }}>Clear all filters</button>
                          {filterSub === "campaign" && (
                            <div className="unified-filter-sub">
                              <button className={`uf-sub-item ${!campaignFilter ? "uf-active" : ""}`} onClick={() => { setCampaignFilter(""); setSelectedId(""); }}>All campaigns</button>
                              {[...new Set(leads.filter((l) => !assignedClients || assignedClients.includes(l.client)).map((l) => l.campaignName).filter(Boolean))].sort().map((c) => (
                                <button key={c!} className={`uf-sub-item ${campaignFilter === c ? "uf-active" : ""}`} onClick={() => { setCampaignFilter(String(c)); setSelectedId(""); }}>{c}</button>
                              ))}
                            </div>
                          )}
                          {filterSub === "sender" && (
                            <div className="unified-filter-sub">
                              <button className={`uf-sub-item ${!senderFilter ? "uf-active" : ""}`} onClick={() => { setSenderFilter(""); setSelectedId(""); }}>All senders</button>
                              {[...new Set(leads.filter((l) => !assignedClients || assignedClients.includes(l.client)).map((l) => l.senderName).filter(Boolean))].sort().map((s) => (
                                <button key={s} className={`uf-sub-item ${senderFilter === s ? "uf-active" : ""}`} onClick={() => { setSenderFilter(s); setSelectedId(""); }}>{s}</button>
                              ))}
                            </div>
                          )}
                          {filterSub === "sentiment" && (
                            <div className="unified-filter-sub">
                              <button className={`uf-sub-item ${!sentimentFilter ? "uf-active" : ""}`} onClick={() => { setSentimentFilter(""); setSelectedId(""); }}>All sentiments</button>
                              {["positive", "neutral", "negative"].map((s) => (
                                <button key={s} className={`uf-sub-item ${sentimentFilter === s ? "uf-active" : ""}`} onClick={() => { setSentimentFilter(s); setSelectedId(""); }}>{s[0].toUpperCase() + s.slice(1)}</button>
                              ))}
                            </div>
                          )}
                          {filterSub === "tier" && (
                            <div className="unified-filter-sub">
                              <button className={`uf-sub-item ${!["Hot", "Warm", "Nurture"].includes(filter) ? "uf-active" : ""}`} onClick={() => { setFilter("All follow-ups"); setSelectedId(""); }}>All tiers</button>
                              {["Hot", "Warm", "Nurture"].map((t) => (
                                <button key={t} className={`uf-sub-item ${filter === t ? "uf-active" : ""}`} onClick={() => { setFilter(t); setSelectedId(""); }}>{t}</button>
                              ))}
                            </div>
                          )}
                          {filterSub === "sort" && (
                            <div className="unified-filter-sub">
                              {[["score-desc", "Score"], ["newest", "Newest"], ["oldest", "Oldest"], ["name", "Name"]].map(([v, l]) => (
                                <button key={v} className={`uf-sub-item ${sort === v ? "uf-active" : ""}`} onClick={() => { setSort(v); setSelectedId(""); }}>{l}</button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
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
                <section className={`queue-card inbox-operational-table${inboxSyncing ? " inbox-syncing" : ""}`}>
                  <div className="inbox-sync-bar">
                    <span className="inbox-sync-label">
                      {inboxSyncing
                        ? "Syncing latest replies from HeyReach…"
                        : lastInboxSync
                          ? `Last synced ${new Date(lastInboxSync).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: appearance.timeZone })}`
                          : "Awaiting first sync"}
                    </span>
                  </div>
                  {inboxSyncing && (
                    <div className="inbox-sync-overlay" role="status" aria-live="polite">
                      <span className="inbox-sync-caption">Refreshing conversations…</span>
                      <div
                        className="inbox-sync-progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={syncProgress.total}
                        aria-valuenow={syncProgress.done}
                      >
                        {/* The floor keeps a sliver of colour on screen from the first frame,
                            so the bar reads as "started" rather than "stuck at empty". */}
                        <span style={{ width: `${Math.max(3, syncPercent)}%` }} />
                      </div>
                      <span className="inbox-sync-count">
                        {syncProgress.total
                          ? `${syncProgress.done} of ${syncProgress.total} conversations`
                          : "Starting…"}
                      </span>
                    </div>
                  )}
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
                  {visibleLeads.map((lead) => (
                    <div
                      className={`lead-row ${filter === "follow-ups" ? "lead-row-followups" : ""} ${current.id === lead.id ? "row-selected" : ""} ${lead.sentiment ? `row-sentiment-${lead.sentiment}` : ""}`}
                      key={lead.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedId(lead.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedId(lead.id);
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
                          <strong className="lead-name">
                            <span className="lead-name-text">{lead.name}</span>
                            {lead.messages.at(-1)?.direction === "outbound" && (
                              <span
                                className="responded-check"
                                title="You've already replied to this thread"
                                aria-label="Replied"
                              >
                                ✓
                              </span>
                            )}
                          </strong>
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
                      </div>
                      <div className="inbox-meta-cell sender-cell">
                        <strong>{lead.senderName}</strong>
                      </div>
                      <div className="inbox-meta-cell turn-cell">
                        <strong>{lead.replies}</strong>
                      </div>
                      <div className="inbox-meta-cell lead-score-cell">
                        <strong>{lead.leadScore ?? "—"}</strong>
                      </div>
                      {filter === "follow-ups" && (
                        <div className="score-cell follow-up-score-cell">
                          <span className={`score-pill ${followUpBand(lead.followUpUrgency ?? 0)}`}>
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
                          <h3>
                            {current.name}
                            {current.messages.at(-1)?.direction === "outbound" && (
                              <span
                                className="responded-check detail-responded-check"
                                title="You've already replied to this thread"
                                aria-label="Replied"
                              >
                                ✓
                              </span>
                            )}
                          </h3>
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
                      <span className={`score-pill ${followUpBand(current.followUpUrgency ?? 0)}`}>
                        {current.followUpUrgency ?? 0} · {followUpBand(current.followUpUrgency ?? 0)}
                      </span>
                      {current.campaignName && (
                        // Straight through to this campaign's analytics. The client
                        // slug is passed when we have it so the page does not have to
                        // guess which workspace a shared campaign name belongs to.
                        <a
                          className="tag-outline tag-outline-link"
                          href={`/analytics?${new URLSearchParams({ ...(current.clientSlug ? { client: current.clientSlug } : {}), campaign: current.campaignName }).toString()}`}
                          title={`Open ${current.campaignName} analytics`}
                        >
                          {current.campaignName}
                        </a>
                      )}
                      {current.sentiment && (
                        <button
                          type="button"
                          className={`sentiment-badge sentiment-${current.sentiment} sentiment-badge-action`}
                          onClick={() => void rescoreSentiment()}
                          disabled={sentimentBusy}
                          title="Re-score this reply with the current sentiment rules"
                        >
                          {sentimentBusy ? "scoring…" : current.sentiment}
                        </button>
                      )}
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
                  {/* Only in the Follow-ups view. Everywhere else this is a second paragraph of prose
                      above the thread saying much what the flag reason already said, and the thread is
                      what the pane is for. The urgency score still rides on every row's score pill. */}
                  {filter === "follow-ups" && current.followUpReason && (current.followUpUrgency ?? 0) >= followUpThreshold && (
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
                        <button type="button" onClick={() => void generateAiReview(workspaceAi, true)} disabled={aiLoading}>{aiLoading ? "Generating…" : "Regenerate ↻"}</button>
                      </div>
                    </div>
                    {current.messages.at(-1)?.direction === "outbound" && !composeAnyway ? (
                      <button
                        type="button"
                        className="composer-replied-state"
                        onClick={() => setComposeAnyway(true)}
                        title="Write a follow-up anyway"
                      >
                        <span className="responded-check composer-responded-check" aria-hidden="true">✓</span>
                        <span>Lead has been replied to!</span>
                      </button>
                    ) : (
                      <textarea
                        value={aiDraft}
                        onChange={(event) => setAiDraft(event.target.value)}
                        placeholder={aiLoading ? "Generating a draft…" : "Anthropic draft will appear here."}
                      />
                    )}
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
                  <div className="thread-refresh-bar">
                    <small className="last-refreshed">
                      {current.lastRefreshedAt
                        ? `Last synced ${new Date(current.lastRefreshedAt).toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: appearance.timeZone })} @ ${new Date(current.lastRefreshedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: appearance.timeZone })}`
                        : "Not yet synced"}
                    </small>
                    <button
                      type="button"
                      className="refresh-btn"
                      disabled={refreshing}
                      onClick={() => void refreshConversation(current.id)}
                      title="Refresh conversation from HeyReach"
                    >
                      <svg className={refreshing ? "spin" : ""} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
                    </button>
                  </div>
                </aside>
              </div>
            </div>
          </div>
        </div>
      </section>
      {toastMessage && <div className="refresh-toast">{toastMessage}</div>}
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
}: {
  label: string;
  value: string;
  delta: string;
  tone: string;
}) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`} />
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{delta}</em>
    </div>
  );
}

/** Dimensions bucket the live inbox rows along the x axis. */
const graphDimensions = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "client", label: "Client" },
  { id: "campaign", label: "Campaign" },
  { id: "sender", label: "Sender" },
  { id: "sentiment", label: "Sentiment" },
  { id: "urgency", label: "Follow-up urgency" },
  { id: "icp", label: "ICP score band" },
];
/** Measures reduce the rows inside a bucket to a single y value. */
const graphMeasures = [
  { id: "conversations", label: "Conversations", format: "count" },
  { id: "replies", label: "Replies", format: "count" },
  { id: "positive", label: "Positive replies", format: "count" },
  { id: "positiveRate", label: "Positive reply rate", format: "percent" },
  { id: "avgReplies", label: "Avg. replies per conversation", format: "decimal" },
  { id: "avgIcp", label: "Avg. ICP score", format: "decimal" },
  { id: "avgUrgency", label: "Avg. follow-up urgency", format: "decimal" },
];
const graphKinds: Array<{ id: GraphKind; label: string }> = [
  { id: "area", label: "Area" },
  { id: "line", label: "Line" },
  { id: "bars", label: "Columns" },
  { id: "hbars", label: "Horizontal bars" },
  { id: "donut", label: "Donut" },
];
const graphPresets: Array<Omit<GraphConfig, "id">> = [
  { title: "Replies per day", x: "day", y: "replies", kind: "area" },
  { title: "Conversations per day", x: "day", y: "conversations", kind: "line" },
  { title: "Replies per week", x: "week", y: "replies", kind: "bars" },
  { title: "Sentiment mix", x: "sentiment", y: "conversations", kind: "donut" },
  { title: "Conversations by client", x: "client", y: "conversations", kind: "hbars" },
  { title: "Positive reply rate by client", x: "client", y: "positiveRate", kind: "hbars" },
  { title: "Top campaigns by replies", x: "campaign", y: "replies", kind: "hbars" },
  { title: "Positive reply rate by campaign", x: "campaign", y: "positiveRate", kind: "hbars" },
  { title: "Conversations by sender", x: "sender", y: "conversations", kind: "hbars" },
  { title: "Follow-up urgency mix", x: "urgency", y: "conversations", kind: "donut" },
  { title: "Avg. ICP score by client", x: "client", y: "avgIcp", kind: "hbars" },
  { title: "ICP score spread", x: "icp", y: "conversations", kind: "bars" },
  { title: "Avg. replies by sentiment", x: "sentiment", y: "avgReplies", kind: "bars" },
];

/** Older saved preferences stored a free-text `metric`; map them onto the axis model. */
const legacyGraphAxes: Record<string, { x: string; y: string }> = {
  "Replies · 7 days": { x: "day", y: "replies" },
  "Lead status": { x: "urgency", y: "conversations" },
  "Positive replies": { x: "client", y: "positive" },
  "Avg. reply time": { x: "day", y: "avgReplies" },
  "Leads by client": { x: "client", y: "conversations" },
};
function normalizeGraphs(value: unknown): GraphConfig[] {
  if (!Array.isArray(value)) return defaultLayout.graphs;
  const graphs = value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const legacy = legacyGraphAxes[String(raw.metric ?? "")];
    const x = graphDimensions.some((item) => item.id === raw.x)
      ? String(raw.x)
      : legacy?.x ?? "day";
    const y = graphMeasures.some((item) => item.id === raw.y)
      ? String(raw.y)
      : legacy?.y ?? "conversations";
    const kind = graphKinds.some((item) => item.id === raw.kind)
      ? (raw.kind as GraphKind)
      : "bars";
    return [
      {
        id: String(raw.id || `graph-${index}`),
        title: String(raw.title || "Untitled graph"),
        x,
        y,
        kind,
      },
    ];
  });
  return graphs.length ? graphs : defaultLayout.graphs;
}

const DAY_MS = 86_400_000;
/** Midnight of the row's date in the viewer's timezone, as a comparable stamp. */
const dayStamp = (value: string | null | undefined, timeZone: string) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const stamp = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(stamp) ? null : stamp;
};
const icpBandLabel = (score: number | null | undefined) => {
  if (typeof score !== "number" || Number.isNaN(score)) return "Unscored";
  if (score >= 80) return "80–100";
  if (score >= 60) return "60–79";
  if (score >= 40) return "40–59";
  return "Under 40";
};
const orderedBuckets: Record<string, string[]> = {
  sentiment: ["Positive", "Neutral", "Negative", "Unscored"],
  urgency: ["Hot", "Warm", "Cold", "Nurture", "Unscored"],
  icp: ["80–100", "60–79", "40–59", "Under 40", "Unscored"],
};
const bucketToneClass: Record<string, string> = {
  Positive: "tone-good",
  Negative: "tone-bad",
  Neutral: "tone-neutral",
  Hot: "tone-bad",
  Warm: "tone-warn",
  Cold: "tone-neutral",
  Nurture: "tone-muted",
  Unscored: "tone-muted",
};

type SeriesPoint = { label: string; value: number; rows: number };

function measureRows(rows: Lead[], measure: string): number {
  if (!rows.length) return 0;
  const replies = () => rows.reduce((sum, row) => sum + (row.replies || 0), 0);
  switch (measure) {
    case "replies":
      return replies();
    case "positive":
      return rows.filter((row) => row.sentiment === "positive").length;
    case "positiveRate": {
      const scored = rows.filter((row) => row.sentiment);
      if (!scored.length) return 0;
      return (
        (scored.filter((row) => row.sentiment === "positive").length /
          scored.length) *
        100
      );
    }
    case "avgReplies":
      return replies() / rows.length;
    case "avgIcp": {
      const scored = rows.filter((row) => typeof row.leadScore === "number");
      if (!scored.length) return 0;
      return (
        scored.reduce((sum, row) => sum + Number(row.leadScore), 0) /
        scored.length
      );
    }
    case "avgUrgency": {
      const scored = rows.filter((row) => Number(row.followUpUrgency) > 0);
      if (!scored.length) return 0;
      return (
        scored.reduce((sum, row) => sum + Number(row.followUpUrgency), 0) /
        scored.length
      );
    }
    default:
      return rows.length;
  }
}

/**
 * Buckets the rows currently visible in the inbox, so every graph reflects exactly the
 * conversations the operator is looking at (including their client and status filters).
 */
function buildSeries(
  rows: Lead[],
  x: string,
  y: string,
  timeZone: string,
): SeriesPoint[] {
  if (x === "day" || x === "week") {
    const span = x === "day" ? 14 : 8;
    const step = (x === "day" ? 1 : 7) * DAY_MS;
    const today = dayStamp(new Date().toISOString(), timeZone);
    if (today === null) return [];
    const buckets = Array.from({ length: span }, (_, index) => ({
      start: today - (span - 1 - index) * step,
      rows: [] as Lead[],
    }));
    for (const row of rows) {
      const stamp = dayStamp(row.latestReplyAt || row.lastMessageAt, timeZone);
      if (stamp === null) continue;
      const stepsBack = Math.max(0, Math.floor((today - stamp) / step));
      const index = span - 1 - stepsBack;
      if (index >= 0) buckets[index].rows.push(row);
    }
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    });
    return buckets.map((bucket) => ({
      label: formatter.format(new Date(bucket.start)),
      value: measureRows(bucket.rows, y),
      rows: bucket.rows.length,
    }));
  }

  const keyFor = (row: Lead) => {
    switch (x) {
      case "client":
        return row.client || "Unassigned";
      case "campaign":
        return row.campaignName || "No campaign";
      case "sender":
        return row.senderName || "Unknown sender";
      case "sentiment":
        return row.sentiment
          ? row.sentiment.charAt(0).toUpperCase() + row.sentiment.slice(1)
          : "Unscored";
      case "urgency": {
        const urgency = Number(row.followUpUrgency) || 0;
        if (!urgency) return "Unscored";
        const band = followUpBand(urgency);
        return band.charAt(0).toUpperCase() + band.slice(1);
      }
      case "icp":
        return icpBandLabel(row.leadScore);
      default:
        return "All";
    }
  };
  const grouped = new Map<string, Lead[]>();
  for (const row of rows) {
    const key = keyFor(row);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  const fixedOrder = orderedBuckets[x];
  if (fixedOrder) {
    return fixedOrder
      .filter((label) => grouped.has(label))
      .map((label) => {
        const bucket = grouped.get(label) ?? [];
        return { label, value: measureRows(bucket, y), rows: bucket.length };
      });
  }
  const points = [...grouped.entries()]
    .map(([label, bucket]) => ({
      label,
      value: measureRows(bucket, y),
      rows: bucket.length,
    }))
    .sort((a, b) => b.value - a.value || b.rows - a.rows);
  // Long tails (dozens of campaigns) are unreadable, so keep the top slice.
  if (points.length <= 10) return points;
  return points.slice(0, 10);
}

const formatMeasure = (value: number, format: string) => {
  if (format === "percent") return `${Math.round(value)}%`;
  if (format === "decimal") return (Math.round(value * 10) / 10).toLocaleString();
  return Math.round(value).toLocaleString();
};
/** Rounds an axis maximum up to a readable tick value. */
const niceMax = (max: number) => {
  if (!(max > 0)) return 1;
  const exponent = Math.floor(Math.log10(max));
  const base = 10 ** exponent;
  const scaled = max / base;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * base;
};

function InboxAnalytics({
  graphs,
  leads,
  filterLabel,
  timeZone,
  loading,
  onChange,
}: {
  graphs: GraphConfig[];
  leads: Lead[];
  filterLabel: string;
  timeZone: string;
  loading: boolean;
  onChange: (graphs: GraphConfig[]) => void;
}) {
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [customTitle, setCustomTitle] = useState("");
  const [customX, setCustomX] = useState("client");
  const [customY, setCustomY] = useState("conversations");
  const [customKind, setCustomKind] = useState<GraphKind>("hbars");
  const nextGraphId = useRef(0);

  const update = (id: string, patch: Partial<GraphConfig>) =>
    onChange(
      graphs.map((graph) => (graph.id === id ? { ...graph, ...patch } : graph)),
    );
  const move = (id: string, offset: number) => {
    const from = graphs.findIndex((graph) => graph.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= graphs.length) return;
    const next = [...graphs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };
  const addGraph = (graph: Omit<GraphConfig, "id">) => {
    if (graphs.length >= 6) return;
    nextGraphId.current += 1;
    const id = `graph-${graph.x}-${graph.y}-${graph.kind}-${nextGraphId.current}`;
    onChange([...graphs, { ...graph, id }]);
    setBuilderOpen(false);
  };
  const addCustom = () => {
    const dimension = graphDimensions.find((item) => item.id === customX);
    const measure = graphMeasures.find((item) => item.id === customY);
    addGraph({
      title:
        customTitle.trim() ||
        `${measure?.label ?? "Value"} by ${(dimension?.label ?? "group").toLowerCase()}`,
      x: customX,
      y: customY,
      kind: customKind,
    });
    setCustomTitle("");
  };

  return (
    <section className="inbox-analytics-section">
      <div className="inbox-analytics-heading">
        <div>
          <h2>Client analytics</h2>
          {/* The charts are drawn from the already-filtered queue, so name the
              range instead of restating the row count nobody was reading. */}
          <span className="inbox-analytics-range">
            {loading ? "Loading…" : filterLabel}
          </span>
        </div>
        <div className="graph-toolbar">
          <button
            className="graph-toolbar-add"
            onClick={() => setBuilderOpen((open) => !open)}
            disabled={graphs.length >= 6}
          >
            {builderOpen ? "Close" : "+ Add graph"}
          </button>
        </div>
      </div>
      {builderOpen && (
        <div className="graph-builder-panel">
          <div className="graph-builder-presets">
            <h4>Preset graphs</h4>
            <div>
              {graphPresets.map((preset) => (
                <button key={preset.title} onClick={() => addGraph(preset)}>
                  {preset.title}
                </button>
              ))}
            </div>
          </div>
          <div className="graph-builder-custom">
            <h4>Build your own</h4>
            <label>
              <span>Title</span>
              <input
                value={customTitle}
                onChange={(event) => setCustomTitle(event.target.value)}
                placeholder="Optional"
              />
            </label>
            <label>
              <span>X axis</span>
              <select
                value={customX}
                onChange={(event) => setCustomX(event.target.value)}
              >
                {graphDimensions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Y axis</span>
              <select
                value={customY}
                onChange={(event) => setCustomY(event.target.value)}
              >
                {graphMeasures.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Type</span>
              <select
                value={customKind}
                onChange={(event) =>
                  setCustomKind(event.target.value as GraphKind)
                }
              >
                {graphKinds.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={addCustom}>Add to dashboard</button>
          </div>
        </div>
      )}
      {graphs.length === 0 && (
        <p className="analytics-empty">
          No graphs yet — add a preset or build your own.
        </p>
      )}
      <div className="inbox-graph-grid">
        {graphs.map((graph, index) => {
          const measure = graphMeasures.find((item) => item.id === graph.y);
          const points = buildSeries(leads, graph.x, graph.y, timeZone);
          return (
            <article
              className={`inbox-graph-card kind-${graph.kind}`}
              key={graph.id}
            >
              <div className="inbox-graph-card-heading">
                {/* The card carries the title its owner gave it and nothing else — the axes
                    are readable off the chart, and the running total was never asked for. */}
                <strong>{graph.title}</strong>
                <div className="inbox-graph-card-actions">
                  <button
                    aria-label="Move left"
                    disabled={index === 0}
                    onClick={() => move(graph.id, -1)}
                  >
                    ‹
                  </button>
                  <button
                    aria-label="Move right"
                    disabled={index === graphs.length - 1}
                    onClick={() => move(graph.id, 1)}
                  >
                    ›
                  </button>
                  <button
                    aria-label={`Configure ${graph.title}`}
                    className={editing === graph.id ? "is-active" : ""}
                    onClick={() =>
                      setEditing(editing === graph.id ? null : graph.id)
                    }
                  >
                    ⚙
                  </button>
                  <button
                    aria-label={`Remove ${graph.title}`}
                    onClick={() =>
                      onChange(graphs.filter((item) => item.id !== graph.id))
                    }
                  >
                    ×
                  </button>
                </div>
              </div>
              {editing === graph.id && (
                <div className="inbox-graph-axes">
                  <label>
                    <span>X</span>
                    <select
                      value={graph.x}
                      onChange={(event) =>
                        update(graph.id, { x: event.target.value })
                      }
                    >
                      {graphDimensions.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Y</span>
                    <select
                      value={graph.y}
                      onChange={(event) =>
                        update(graph.id, { y: event.target.value })
                      }
                    >
                      {graphMeasures.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Type</span>
                    <select
                      value={graph.kind}
                      onChange={(event) =>
                        update(graph.id, {
                          kind: event.target.value as GraphKind,
                        })
                      }
                    >
                      {graphKinds.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    value={graph.title}
                    onChange={(event) =>
                      update(graph.id, { title: event.target.value })
                    }
                    aria-label="Graph title"
                  />
                </div>
              )}
              <GraphVisual
                kind={graph.kind}
                points={points}
                format={measure?.format ?? "count"}
                measureLabel={measure?.label ?? graph.y}
                loading={loading}
              />
            </article>
          );
        })}
      </div>
    </section>
  );
}

function GraphVisual({
  kind,
  points,
  format,
  measureLabel,
  loading,
}: {
  kind: GraphKind;
  points: SeriesPoint[];
  format: string;
  measureLabel: string;
  loading: boolean;
}) {
  if (loading) return <div className="analytics-empty">Loading…</div>;
  const populated = points.some((point) => point.value > 0);
  if (!points.length || !populated)
    return <div className="analytics-empty">No data for this view yet</div>;

  if (kind === "donut") {
    const total = points.reduce((sum, point) => sum + point.value, 0);
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    // Slices are laid out by accumulating the dash offset up front so rendering stays pure.
    const slices = points.reduce<
      Array<SeriesPoint & { share: number; dash: number; offset: number }>
    >((accumulator, point) => {
      const previous = accumulator[accumulator.length - 1];
      const offset = previous ? previous.offset + previous.dash : 0;
      const share = total ? point.value / total : 0;
      return [...accumulator, { ...point, share, dash: share * circumference, offset }];
    }, []);
    return (
      <div className="inbox-donut-chart">
        <svg viewBox="0 0 140 140" role="img" aria-label={measureLabel}>
          <circle className="donut-track" cx="70" cy="70" r={radius} />
          {slices.map((slice, index) => (
            <circle
              key={slice.label}
              className={`donut-slice ${bucketToneClass[slice.label] ?? `series-${index % 6}`}`}
              cx="70"
              cy="70"
              r={radius}
              strokeDasharray={`${slice.dash} ${circumference - slice.dash}`}
              strokeDashoffset={-slice.offset}
            >
              <title>{`${slice.label}: ${formatMeasure(slice.value, format)} (${Math.round(slice.share * 100)}%)`}</title>
            </circle>
          ))}
          <text className="donut-total" x="70" y="66">
            {formatMeasure(total, format === "percent" ? "decimal" : format)}
          </text>
          <text className="donut-caption" x="70" y="82">
            total
          </text>
        </svg>
        <ul className="graph-legend">
          {points.map((point, index) => (
            <li key={point.label}>
              <i
                className={
                  bucketToneClass[point.label] ?? `series-${index % 6}`
                }
              />
              <span>{point.label}</span>
              <b>{formatMeasure(point.value, format)}</b>
              <em>
                {total ? Math.round((point.value / total) * 100) : 0}%
              </em>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (kind === "hbars") {
    const max = Math.max(...points.map((point) => point.value), 1);
    return (
      <div className="inbox-hbars">
        {points.map((point, index) => (
          <div className="inbox-hbar-row" key={`${point.label}-${index}`}>
            <span title={point.label}>{point.label}</span>
            <div>
              <i
                className={
                  bucketToneClass[point.label] ?? `series-${index % 6}`
                }
                style={{ width: `${Math.max(2, (point.value / max) * 100)}%` }}
              />
            </div>
            <b>{formatMeasure(point.value, format)}</b>
          </div>
        ))}
      </div>
    );
  }

  // Column charts label every bar, because a bar with no name under it reads as a gap in the
  // data. Once there are more than a handful the names are tilted instead of thinned out,
  // which costs a little height and buys room for a legible label per bar.
  const tilted = kind === "bars" && points.length > 5;
  const width = 460;
  const height = tilted ? 206 : 176;
  const padLeft = 40;
  const padRight = 10;
  const padTop = 12;
  const padBottom = tilted ? 58 : 28;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const max = niceMax(Math.max(...points.map((point) => point.value)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    ratio,
    value: max * ratio,
    y: padTop + plotHeight * (1 - ratio),
  }));
  // Only label every nth category when the axis would otherwise collide. Columns are exempt:
  // they carry one label each, tilted if need be.
  const labelStep = kind === "bars" ? 1 : Math.ceil(points.length / 8);

  if (kind === "bars") {
    const slot = plotWidth / points.length;
    const barWidth = Math.max(4, Math.min(30, slot * 0.6));
    return (
      <svg
        className="inbox-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={measureLabel}
      >
        {ticks.map((tick) => (
          <g key={tick.ratio}>
            <line
              className="chart-grid"
              x1={padLeft}
              x2={width - padRight}
              y1={tick.y}
              y2={tick.y}
            />
            <text className="chart-axis" x={padLeft - 6} y={tick.y + 3}>
              {formatMeasure(tick.value, format)}
            </text>
          </g>
        ))}
        {points.map((point, index) => {
          const barHeight = max ? (point.value / max) * plotHeight : 0;
          return (
            <g key={`${point.label}-${index}`}>
              <rect
                className={`chart-bar ${bucketToneClass[point.label] ?? ""}`}
                x={padLeft + slot * index + (slot - barWidth) / 2}
                y={padTop + plotHeight - barHeight}
                width={barWidth}
                height={Math.max(barHeight, point.value > 0 ? 2 : 0)}
                rx="2"
              >
                <title>{`${point.label}: ${formatMeasure(point.value, format)}`}</title>
              </rect>
              {index % labelStep === 0 &&
                (() => {
                  const anchorX = padLeft + slot * index + slot / 2;
                  const anchorY = height - padBottom + (tilted ? 14 : 19);
                  const limit = tilted ? 16 : 10;
                  return (
                    <text
                      className={`chart-axis chart-axis-x ${tilted ? "is-tilted" : ""}`}
                      x={anchorX}
                      y={anchorY}
                      transform={
                        tilted
                          ? `rotate(-38 ${anchorX} ${anchorY})`
                          : undefined
                      }
                    >
                      {point.label.length > limit
                        ? `${point.label.slice(0, limit - 1)}…`
                        : point.label}
                    </text>
                  );
                })()}
            </g>
          );
        })}
      </svg>
    );
  }

  const coordinates = points.map((point, index) => ({
    ...point,
    x:
      points.length === 1
        ? padLeft + plotWidth / 2
        : padLeft + (index / (points.length - 1)) * plotWidth,
    y: padTop + plotHeight * (1 - (max ? point.value / max : 0)),
  }));
  const path = coordinates
    .map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`)
    .join(" ");
  return (
    <svg
      className="inbox-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={measureLabel}
    >
      {ticks.map((tick) => (
        <g key={tick.ratio}>
          <line
            className="chart-grid"
            x1={padLeft}
            x2={width - padRight}
            y1={tick.y}
            y2={tick.y}
          />
          <text className="chart-axis" x={padLeft - 6} y={tick.y + 3}>
            {formatMeasure(tick.value, format)}
          </text>
        </g>
      ))}
      {kind === "area" && (
        <path
          className="chart-area"
          d={`${path} L${coordinates[coordinates.length - 1].x} ${padTop + plotHeight} L${coordinates[0].x} ${padTop + plotHeight} Z`}
        />
      )}
      <path className="chart-line" d={path} />
      {coordinates.map((point, index) => (
        <g key={`${point.label}-${index}`}>
          <circle className="chart-dot" cx={point.x} cy={point.y} r="3">
            <title>{`${point.label}: ${formatMeasure(point.value, format)}`}</title>
          </circle>
          {index % labelStep === 0 && (
            <text className="chart-axis chart-axis-x" x={point.x} y={height - 9}>
              {point.label.length > 10
                ? `${point.label.slice(0, 9)}…`
                : point.label}
            </text>
          )}
        </g>
      ))}
    </svg>
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
  // Clicking away commits, the same as the Save button below.
  const popoverRef = usePopoverDismiss<HTMLDivElement>(onSave);
  return (
    <div className="customize-popover layout-popover" ref={popoverRef}>
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
        ]
          // Persisted prefs may include ids from a previous deploy that no longer
          // exist in the catalog. Dropping unknowns prevents the panel from
          // dereferencing `undefined` and taking the whole inbox down.
          .filter((metricId) => metricCatalog.some((item) => item.id === metricId))
          .map((metricId) => {
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
