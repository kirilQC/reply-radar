// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";

type Performance = { name: string; replies: number; messages?: number; messagesSent?: number; conversations?: number; clients?: string[] };
type CampaignMetric = { workspaceId: string; client: string; campaignId: string; name: string; connectionsSent: number; connectionsAccepted: number; replies: number; replies7d?: number; messagesStarted: number; acceptanceRate: number; replyRate: number; positiveReplies: number; positiveReplyRate: number; launchedAt: string | null; status: string | null };
type WorkspaceDetail = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type AnalyticsData = { status?: string; totalReplies?: number; messagesSent?: number; activeConversations?: number; replies7d?: number; trend?: number[]; trendLabels?: string[]; averageDailyReplies?: number; campaignMetrics?: CampaignMetric[]; campaignAverages?: { replyRate: number; acceptanceRate: number; positiveReplyRate: number }; clientPerformance?: Performance[]; campaigns?: Performance[]; senders?: Performance[]; workspaceDetails?: WorkspaceDetail[] };

/**
 * One client's figures, as `/api/analytics/client` returns them.
 *
 * A separate shape from `AnalyticsData` because it has a separate source: the Render worker collects
 * HeyReach into `rr_campaign_stats` and `rr_daily_stats` every half hour and this route only reads
 * Supabase, where the index page's route still calls HeyReach live for every client at once. That is
 * the difference between a page that paints in one round trip and one that painted blank and filled
 * in three seconds later.
 */
type ClientCampaign = {
  campaignId: string; name: string; status: string | null; launchedAt: string | null;
  senderIds: string[]; totalLeads: number; leadsPending: number; leadsInProgress: number; leadsFinished: number;
  connectionsSent: number; connectionsAccepted: number; replies: number; repliesSynced: number;
  messagesStarted: number; positiveReplies: number; acceptanceRate: number; replyRate: number; positiveReplyRate: number;
  firstTouch: string | null; followUp: string | null; sequenceSteps: number | null;
  /** Days of connection requests still to send, at the cap, or null when no sender is assigned. */
  daysLeft: number | null;
};
type DailyPoint = { day: string; label: string; connectionsSent: number; connectionsAccepted: number; messagesSent: number; replies: number };
type SenderSeries = { id: string; name: string; dailyLimit: number | null; connectionsSent: number; connectionsAccepted: number; byDay: number[] };
type ClientAnalytics = {
  status?: string; workspace?: WorkspaceDetail; campaigns?: ClientCampaign[]; daily?: DailyPoint[];
  senders?: SenderSeries[]; senderCap?: number; repliesSynced?: number; replies7d?: number;
  conversations?: number; collectedAt?: string | null;
};

/**
 * Where the last good `/api/analytics` answer is parked between visits.
 *
 * Versioned in the name so a change to `AnalyticsData` cannot be handed a snapshot shaped for the
 * previous version — bumping the `:v1` retires every stored copy at once, which is cheaper and
 * safer than migrating them.
 */
const snapshotKey = "reply-radar-analytics-snapshot:v1";
/** Per client, so opening one does not evict another. Same versioning rule as above. */
const clientSnapshotKey = "reply-radar-client-analytics:v1";

const launchDate = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
/** How long we have worked with a client, measured from their first real campaign launch. */
const engagementRuntime = (campaigns: { launchedAt: string | null }[]) => {
  const stamps = campaigns
    .map((campaign) => (campaign.launchedAt ? new Date(campaign.launchedAt).getTime() : NaN))
    .filter((stamp) => Number.isFinite(stamp));
  if (!stamps.length) return { label: "—", since: "Launch dates unavailable from HeyReach" };
  const first = Math.min(...stamps);
  const days = Math.max(0, Math.floor((Date.now() - first) / 86_400_000));
  const months = Math.floor(days / 30.44);
  const label = days < 31 ? `${days} day${days === 1 ? "" : "s"}` : months < 12 ? `${months} month${months === 1 ? "" : "s"}` : `${Math.floor(months / 12)}y ${months % 12}m`;
  return { label, since: `Since ${launchDate(new Date(first).toISOString())}` };
};

/** A day count written the way somebody would say it out loud. */
const durationLabel = (days: number) => {
  if (days < 31) return `${days}d`;
  const months = Math.floor(days / 30.44);
  return months < 12 ? `${months}mo` : `${Math.floor(months / 12)}y ${months % 12}mo`;
};

const sortOptions = [
  { id: "launch-desc", label: "Newest launch" },
  { id: "launch-asc", label: "Oldest launch" },
  { id: "name-asc", label: "Name A–Z" },
  { id: "name-desc", label: "Name Z–A" },
  { id: "reply-desc", label: "Highest reply rate" },
  { id: "reply-asc", label: "Lowest reply rate" },
  { id: "accept-desc", label: "Highest acceptance rate" },
  { id: "accept-asc", label: "Lowest acceptance rate" },
  { id: "positive-desc", label: "Highest positive rate" },
  { id: "replies-desc", label: "Most replies" },
  { id: "sent-desc", label: "Most requests sent" },
  { id: "accepted-desc", label: "Most connections accepted" },
];
const sortCampaigns = (campaigns: ClientCampaign[], sort: string) => {
  // Rows without a launch date always sink to the bottom of date sorts.
  const stamp = (campaign: ClientCampaign) => (campaign.launchedAt ? new Date(campaign.launchedAt).getTime() : NaN);
  const rows = [...campaigns];
  switch (sort) {
    case "launch-asc":
      return rows.sort((a, b) => (Number.isFinite(stamp(a)) ? stamp(a) : Infinity) - (Number.isFinite(stamp(b)) ? stamp(b) : Infinity));
    case "name-asc":
      return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    case "name-desc":
      return rows.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    case "reply-desc":
      return rows.sort((a, b) => b.replyRate - a.replyRate);
    case "reply-asc":
      return rows.sort((a, b) => a.replyRate - b.replyRate);
    case "accept-desc":
      return rows.sort((a, b) => b.acceptanceRate - a.acceptanceRate);
    case "accept-asc":
      return rows.sort((a, b) => a.acceptanceRate - b.acceptanceRate);
    case "positive-desc":
      return rows.sort((a, b) => b.positiveReplyRate - a.positiveReplyRate);
    case "replies-desc":
      return rows.sort((a, b) => b.replies - a.replies);
    case "sent-desc":
      return rows.sort((a, b) => b.connectionsSent - a.connectionsSent);
    case "accepted-desc":
      return rows.sort((a, b) => b.connectionsAccepted - a.connectionsAccepted);
    default:
      return rows.sort((a, b) => (Number.isFinite(stamp(b)) ? stamp(b) : -Infinity) - (Number.isFinite(stamp(a)) ? stamp(a) : -Infinity));
  }
};

/**
 * The metrics the "best performing" ranking can be read by.
 *
 * Three of them because the honest answer depends on the question. Acceptance says whether the invite
 * note is landing, replies say whether the follow-up is, and positive replies say whether either of
 * them found the right people — a campaign can lead on volume and lose badly on the last one.
 */
const leaderMetrics = [
  { id: "accepted", label: "Connections accepted", of: (row: ClientCampaign) => row.connectionsAccepted },
  { id: "replies", label: "Total replies", of: (row: ClientCampaign) => row.replies },
  { id: "positive", label: "Positive replies", of: (row: ClientCampaign) => row.positiveReplies },
] as const;

const sum = <T,>(rows: T[], of: (row: T) => number) => rows.reduce((total, row) => total + of(row), 0);
/** The first line or so of a message, for a row that has to fit on one. */
const excerpt = (value: string | null, length = 130) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
};
/**
 * Campaigns with enough sent to be worth ranking.
 *
 * A campaign that sent four requests and had one accepted is a 25% acceptance rate and the best on the
 * board, which is why every ranking below runs through this first. Fifty is roughly two days of one
 * sender, which is the point at which the rate stops being an accident.
 */
const RANKABLE_MINIMUM = 50;
const rankable = (campaigns: ClientCampaign[]) => campaigns.filter((row) => row.connectionsSent >= RANKABLE_MINIMUM);

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData>({});
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<ClientCampaign | null>(null);
  const [sort, setSort] = useState("launch-desc");
  const [leaderMetric, setLeaderMetric] = useState<string>("accepted");
  const [copied, setCopied] = useState(false);
  // The campaign name from the URL, resolved against the metrics once they load.
  const [urlCampaign, setUrlCampaign] = useState<string | null>(null);
  /**
   * One client's payload, tagged with whose it is.
   *
   * Tagged rather than cleared on navigation: clearing means a synchronous `setState` in an effect on
   * every slug change, and comparing the tag at render is both cheaper and immune to a stale response
   * from the client you just navigated away from landing on top of the one you are looking at.
   */
  const [clientData, setClientData] = useState<{ slug: string; payload: ClientAnalytics; at: number } | null>(null);
  /** Whether the URL has been read yet. Nothing may fetch before it, or both routes get called. */
  const [routeReady, setRouteReady] = useState(false);

  // The client view is addressable so it can be shared, bookmarked, or served from a
  // per-client subdomain (middleware rewrites `<slug>.host` to `/analytics?client=<slug>`).
  //
  // Declared before the two fetch effects, and gating both of them through `routeReady`, because
  // effects run in source order: without it the first paint of a bookmarked client page would fire
  // the whole-account HeyReach route as well, which is the one thing this rebuild is removing from
  // that path.
  useEffect(() => {
    const readSlug = () => {
      const params = new URLSearchParams(window.location.search);
      setSelectedSlug(params.get("client"));
      setUrlCampaign(params.get("campaign"));
      setRouteReady(true);
    };
    readSlug();
    window.addEventListener("popstate", readSlug);
    return () => window.removeEventListener("popstate", readSlug);
    // `readSlug` calls setState during the mount effect by design — it is how the URL becomes state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
  }, []);

  /**
   * One client's figures, from Supabase alone.
   *
   * Polled more slowly than the index page because the worker only refreshes a client every half hour,
   * so a ten-second poll would return the same rows nine times out of ten. The snapshot is per client
   * and restored first, which is what makes a second visit paint immediately.
   */
  useEffect(() => {
    if (!routeReady || !selectedSlug) return;
    const slug = selectedSlug;
    const cacheKey = `${clientSnapshotKey}:${slug}`;
    try {
      const cached = window.localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { at?: number; payload?: ClientAnalytics };
        if (parsed?.payload && Array.isArray(parsed.payload.campaigns)) {
          // Same argument as the index snapshot below: one extra render is the whole point of it.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setClientData({ slug, payload: parsed.payload, at: parsed.at ?? 0 });
        }
      }
    } catch { /* a corrupt or evicted snapshot just means waiting for the fetch */ }
    let live = true;
    const load = () => fetch(`/api/analytics/client?client=${encodeURIComponent(slug)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: ClientAnalytics) => {
        if (!live) return;
        const at = Date.now();
        setClientData({ slug, payload, at });
        // Kept only when there are campaigns in it, for the same reason the index snapshot is: one
        // failed poll must not leave a blank page on every later visit.
        if (Array.isArray(payload?.campaigns) && payload.campaigns.length) {
          try { window.localStorage.setItem(cacheKey, JSON.stringify({ at, payload })); } catch { /* quota or private mode */ }
        }
      })
      .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 120_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [routeReady, selectedSlug]);

  useEffect(() => {
    // Skipped entirely on a client page: this is the route that calls HeyReach once per client before
    // it can answer, and the per-client view now has everything it needs from Supabase. Coming back to
    // the index re-runs this effect, so nothing is lost by not having fetched it.
    if (!routeReady || selectedSlug) return;
    /**
     * Last run's figures, painted while this run's are still in flight.
     *
     * `/api/analytics` talks to HeyReach for every client before it can answer, so there is a
     * multi-second window on every visit where this page had nothing to draw and showed an empty
     * shell — and because tab switches are now client-side, that emptiness is the *only* thing you
     * see. The numbers from the previous visit are the same numbers this fetch is about to return,
     * give or take a few replies, so showing them is strictly better than showing nothing.
     *
     * Read here rather than in `useState`'s initialiser on purpose: an initialiser runs during
     * render, where the server rendered `{}` and the client would render a full payload, and React
     * discards the whole tree on that mismatch. An effect runs after hydration, so the restore is
     * a normal state update — one frame later, which is imperceptible.
     *
     * The stamp is stored with it and put straight into the "updated HH:MM" label already in the
     * hero, so a restored snapshot says how old it is instead of pretending to be live.
     */
    try {
      const cached = window.localStorage.getItem(snapshotKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { at?: number; data?: AnalyticsData };
        if (parsed?.data && typeof parsed.data === "object") {
          // The one extra render this costs is the entire point of the snapshot — it is what turns
          // an empty shell into last visit's figures. `set-state-in-effect` exists to catch render
          // loops, and this runs once on mount from a value that cannot change.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setData(parsed.data);
          if (parsed.at) setUpdatedAt(new Date(parsed.at));
        }
      }
    } catch { /* a corrupt or evicted snapshot just means the old empty-shell wait */ }
    const load = () => fetch("/api/analytics", { cache: "no-store" }).then((response) => response.json()).then((payload: AnalyticsData) => {
      setData(payload);
      const at = Date.now();
      setUpdatedAt(new Date(at));
      // Only an answer with figures in it is kept, judged on content rather than on a status
      // string: the route can reply `error`, `not_configured`, or a 200 with nothing in it, and any
      // of those overwriting a working snapshot would mean one bad poll leaves the page blank on
      // every later visit. Campaign metrics are the spine of everything below, so their presence is
      // the honest test of whether this payload is worth keeping.
      if (Array.isArray(payload?.campaignMetrics) && payload.campaignMetrics.length) {
        try { window.localStorage.setItem(snapshotKey, JSON.stringify({ at, data: payload })); } catch { /* quota or private mode */ }
      }
    }).catch(() => setData((current) => (current.campaignMetrics?.length ? current : { status: "error" })));
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [routeReady, selectedSlug]);

  const workspaces = data.workspaceDetails ?? [];
  /**
   * This client's figures, or nothing if what is loaded belongs to a different one.
   *
   * The tag comparison is what makes navigating between clients honest: without it the previous
   * client's campaigns would stay on screen under the new client's name until the fetch returned.
   */
  const clientPayload = clientData && clientData.slug === selectedSlug ? clientData.payload : null;
  const clientDetail = clientPayload?.workspace ?? (selectedSlug ? workspaces.find((workspace) => workspace.slug === selectedSlug) ?? null : null);
  const clientCampaigns = clientPayload?.campaigns ?? [];
  const sortedCampaigns = useMemo(() => sortCampaigns(clientCampaigns, sort), [clientCampaigns, sort]);

  /*
   * A `?campaign=` link carries a name rather than an id, because a conversation only knows the name.
   * Resolved against this client's own campaigns, which means such a link needs `?client=` alongside it
   * — the whole-account list it used to be matched against is no longer fetched on a client page, and
   * nothing in the app generates a bare `?campaign=` link to lose.
   */
  const linkedCampaign = useMemo(() => {
    if (!urlCampaign) return null;
    const wanted = urlCampaign.trim().toLowerCase();
    return clientCampaigns.find((campaign) => campaign.name.trim().toLowerCase() === wanted) ?? null;
  }, [urlCampaign, clientCampaigns]);
  const activeCampaign = selectedCampaign ?? linkedCampaign;

  // Closing the modal also drops `?campaign=` so a refresh does not reopen it.
  const closeCampaign = () => {
    setSelectedCampaign(null);
    setUrlCampaign(null);
    const params = new URLSearchParams(window.location.search);
    if (!params.has("campaign")) return;
    params.delete("campaign");
    const query = params.toString();
    window.history.replaceState({}, "", query ? `/analytics?${query}` : "/analytics");
  };
  useEffect(() => {
    if (!activeCampaign) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCampaign();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCampaign]);
  const openClient = (slug: string | null) => {
    setSelectedSlug(slug);
    setSelectedCampaign(null);
    setUrlCampaign(null);
    setCopied(false);
    const url = slug ? `/analytics?client=${encodeURIComponent(slug)}` : "/analytics";
    window.history.pushState({}, "", url);
  };

  if (selectedSlug) {
    /*
     * The client page renders on the slug alone, not on having found the client.
     *
     * Waiting for a resolved workspace meant a bookmarked client URL fell through to the index render
     * for as long as the fetch took — the wrong page, briefly, rather than this one unfilled.
     */
    const detail = clientDetail ?? { id: "", name: selectedSlug, slug: selectedSlug, logoUrl: null, accentColor: null };
    const daily = clientPayload?.daily ?? [];
    const senders = clientPayload?.senders ?? [];
    const senderCap = clientPayload?.senderCap ?? 25;
    const average = (key: "replyRate" | "acceptanceRate" | "positiveReplyRate") =>
      clientCampaigns.length ? sum(clientCampaigns, (campaign) => campaign[key]) / clientCampaigns.length : null;
    // HeyReach reply totals cover the full campaign history, not just what we have synced.
    const allTimeReplies = sum(clientCampaigns, (campaign) => campaign.replies);
    const runtime = engagementRuntime(clientCampaigns);
    const contacted = sum(clientCampaigns, (campaign) => campaign.connectionsSent);
    const accepted = sum(clientCampaigns, (campaign) => campaign.connectionsAccepted);
    const launched = clientCampaigns.filter((campaign) => campaign.launchedAt).length;
    // Campaigns still working through their list, longest runway first — the ones that need senders.
    const running = clientCampaigns
      .filter((campaign) => String(campaign.status ?? "").toUpperCase() === "IN_PROGRESS")
      .sort((left, right) => (right.daysLeft ?? 0) - (left.daysLeft ?? 0) || right.leadsPending - left.leadsPending);
    const windowSent = sum(daily, (point) => point.connectionsSent);
    const sentMax = Math.max(...daily.map((point) => point.connectionsSent), 1);
    // The stacked chart is scaled on its own busiest column rather than on the total series, so the two
    // charts are read independently and neither flattens the other.
    const stackMax = Math.max(...daily.map((_, index) => sum(senders, (sender) => sender.byDay[index] ?? 0)), 1);
    const metric = leaderMetrics.find((option) => option.id === leaderMetric) ?? leaderMetrics[0];
    const ranked = rankable(clientCampaigns);
    const leaders = [...ranked].sort((left, right) => metric.of(right) - metric.of(left)).slice(0, 6);
    const leaderMax = Math.max(...leaders.map((row) => metric.of(row)), 1);
    // Worst acceptance first. Acceptance rather than replies because it is the earliest thing that can
    // be wrong: nothing downstream of a request nobody accepts is worth diagnosing.
    const laggards = [...ranked].sort((left, right) => left.acceptanceRate - right.acceptanceRate).slice(0, 6);
    const messaging = ranked
      .filter((campaign) => campaign.firstTouch)
      .sort((left, right) => right.acceptanceRate - left.acceptanceRate)
      .slice(0, 5);
    const collectedAt = clientPayload?.collectedAt ? new Date(clientPayload.collectedAt) : null;
    // Strip an existing client label so the shown host stays `<slug>.<root domain>`.
    const host = typeof window === "undefined" ? "" : window.location.host;
    const rootHost = host.startsWith(`${detail.slug}.`) ? host.slice(detail.slug.length + 1) : host;
    const shareUrl = `${detail.slug}.${rootHost}`;
    return <div className="app-shell"><AppSidebar/><section className="main-area">
      <header className="topbar"><Crumb trail={[{ label: "Analytics", href: "/analytics", onClick: (event) => { event.preventDefault(); openClient(null); } }, { label: detail.name }]} /><div className="top-actions"><GlobalAppearanceControl /></div></header>
      <main className="analytics-dashboard">
        <header className="analytics-hero client-hero">
          <div className="client-hero-identity">
            <i className="client-hero-logo" style={detail.logoUrl ? undefined : { background: detail.accentColor || "var(--accent)" }}>
              {detail.logoUrl ? <img src={detail.logoUrl} alt={detail.name} /> : detail.name[0]}
            </i>
            <div>
              <button className="analytics-back" onClick={() => openClient(null)}>← All clients</button>
              <h1>{detail.name}</h1>
              <button
                className="client-share-url"
                title="Copy this client's analytics URL"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${window.location.origin}/analytics?client=${encodeURIComponent(detail.slug)}`);
                  setCopied(true);
                }}
              >
                {copied ? "Copied link" : shareUrl}
              </button>
            </div>
          </div>
          {/* Stamped with when the worker last read HeyReach, not with when this page was opened. The
              figures are up to half an hour old and saying so is the difference between a stale number
              and a wrong one. */}
          <div className="analytics-live"><i /> HeyReach{collectedAt ? ` · collected ${collectedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : " · collecting"}</div>
        </header>
        <section className="analytics-kpis">
          <Kpi label="All-time replies" value={allTimeReplies.toLocaleString()} sub={`${(clientPayload?.repliesSynced ?? 0).toLocaleString()} synced to the inbox`}/>
          <Kpi label="Average reply rate" value={average("replyRate") == null ? "—" : `${average("replyRate")!.toFixed(1)}%`}/>
          <Kpi label="Average acceptance rate" value={average("acceptanceRate") == null ? "—" : `${average("acceptanceRate")!.toFixed(1)}%`}/>
          <Kpi label="Average positive reply rate" value={average("positiveReplyRate") == null ? "—" : `${average("positiveReplyRate")!.toFixed(1)}%`}/>
          <Kpi label="Engagement runtime" value={runtime.label} sub={runtime.since}/>
        </section>
        <section className="analytics-kpis analytics-kpis-secondary">
          <Kpi label="Leads reached out to" value={contacted.toLocaleString()} sub="Connection requests sent, all time"/>
          <Kpi label="Connections accepted" value={accepted.toLocaleString()} sub={contacted ? `${((accepted / contacted) * 100).toFixed(1)}% of requests sent` : undefined}/>
          <Kpi label="Campaigns launched" value={launched.toLocaleString()} sub={`${clientCampaigns.length.toLocaleString()} tracked`}/>
          <Kpi label="Campaigns running" value={running.length.toLocaleString()} sub={`${senders.length} sender${senders.length === 1 ? "" : "s"} active`}/>
          <Kpi label="Requests last 14 days" value={windowSent.toLocaleString()} sub={`${Math.round(windowSent / Math.max(daily.length, 1)).toLocaleString()} a day`}/>
        </section>

        <section className="analytics-primary">
          <article className="analytics-card analytics-trend">
            <CardTitle title="Connection requests sent" subtitle={`Every sender, day by day · ${windowSent.toLocaleString()} in the last ${daily.length || 14} days`}/>
            <div className="analytics-bars">
              {daily.map((point) => (
                <div key={point.day}>
                  <strong>{point.connectionsSent}</strong>
                  <i style={{ height: `${Math.max(4, (point.connectionsSent / sentMax) * 100)}%` }}/>
                  <small>{point.label}</small>
                </div>
              ))}
            </div>
            {!daily.length && <p className="empty-state">No daily figures collected yet.</p>}
          </article>
        </section>

        <section className="analytics-primary">
          <article className="analytics-card">
            <CardTitle title="Connection requests by sender" subtitle={`${senders.length} sender${senders.length === 1 ? "" : "s"} · ${senderCap} a day each is the cap, so a full column is about ${(senders.length * senderCap).toLocaleString()}`}/>
            {/* Stacked as divs: each sender is one segment of the day's column, sized against the
                busiest day in the window, so a column's height is the day's total and its bands are
                who sent it. */}
            <div className="sender-stack">
              {daily.map((point, index) => {
                const total = sum(senders, (sender) => sender.byDay[index] ?? 0);
                return (
                  <div key={point.day}>
                    <strong>{total || ""}</strong>
                    <span>
                      {senders.map((sender, order) => {
                        const value = sender.byDay[index] ?? 0;
                        if (!value) return null;
                        return <i key={sender.id} data-tone={order % 6} style={{ height: `${(value / stackMax) * 100}%` }} title={`${sender.name}: ${value}`}/>;
                      })}
                    </span>
                    <small>{point.label}</small>
                  </div>
                );
              })}
            </div>
            <div className="sender-legend">
              {senders.map((sender, order) => (
                <span key={sender.id}>
                  <i data-tone={order % 6}/>
                  <em>{sender.name}</em>
                  <b>{sender.connectionsSent.toLocaleString()}</b>
                  <small>{Math.round(sender.connectionsSent / Math.max(daily.length, 1))}/day{sender.dailyLimit ? ` of ${sender.dailyLimit}` : ""}</small>
                </span>
              ))}
            </div>
            {!senders.length && <p className="empty-state">No sender activity in the last fortnight.</p>}
          </article>
        </section>

        <section className="analytics-grid">
          <article className="analytics-card analytics-ranking">
            <CardTitle title="Active campaigns" subtitle={`Sending days left at ${senderCap} requests per sender per day`}/>
            {running.length ? running.slice(0, 8).map((campaign) => (
              <button type="button" className="campaign-runway" key={campaign.campaignId} onClick={() => setSelectedCampaign(campaign)}>
                <span>
                  <strong>{campaign.name}</strong>
                  <small>{campaign.senderIds.length} sender{campaign.senderIds.length === 1 ? "" : "s"} · {campaign.leadsPending.toLocaleString()} still to contact</small>
                </span>
                <data>{campaign.daysLeft === null ? "—" : campaign.daysLeft === 0 ? "Done" : `${campaign.daysLeft}d`}</data>
              </button>
            )) : <p className="empty-state">Nothing running right now.</p>}
          </article>

          <article className="analytics-card analytics-ranking">
            <CardTitle title="Best performing campaigns" subtitle={`Over ${RANKABLE_MINIMUM} requests sent`}/>
            <div className="metric-toggle">
              {leaderMetrics.map((option) => (
                <button type="button" key={option.id} className={option.id === metric.id ? "is-active" : ""} onClick={() => setLeaderMetric(option.id)}>
                  {option.label}
                </button>
              ))}
            </div>
            {leaders.length ? leaders.map((campaign, index) => (
              <button type="button" className="analytics-rank is-button" key={campaign.campaignId} onClick={() => setSelectedCampaign(campaign)}>
                <b>{index + 1}</b>
                <span>
                  <strong>{campaign.name}</strong>
                  <small>{campaign.acceptanceRate.toFixed(1)}% accepted · {campaign.replyRate.toFixed(1)}% replied</small>
                  <i><em style={{ width: `${(metric.of(campaign) / leaderMax) * 100}%` }}/></i>
                </span>
                <data>{metric.of(campaign).toLocaleString()}</data>
              </button>
            )) : <p className="empty-state">No campaign has sent enough to rank yet.</p>}
          </article>

          <article className="analytics-card analytics-ranking">
            <CardTitle title="Underperforming campaigns" subtitle="Lowest acceptance rate first"/>
            {laggards.length ? laggards.map((campaign) => (
              <button type="button" className="analytics-rank is-button no-index" key={campaign.campaignId} onClick={() => setSelectedCampaign(campaign)}>
                <span>
                  <strong>{campaign.name}</strong>
                  <small>{campaign.connectionsSent.toLocaleString()} sent · {campaign.connectionsAccepted.toLocaleString()} accepted · {campaign.replies.toLocaleString()} replies</small>
                  <i><em className="is-warning" style={{ width: `${Math.min(100, campaign.acceptanceRate * 2)}%` }}/></i>
                </span>
                <data>{campaign.acceptanceRate.toFixed(1)}%</data>
              </button>
            )) : <p className="empty-state">No campaign has sent enough to rank yet.</p>}
          </article>
        </section>

        {/* The copy next to the rates it produced. A campaign name means nothing to anybody who did not
            write it, so ranking campaigns by acceptance without showing what they said answers "which
            campaign" when the question was "which message". */}
        <section className="analytics-card messaging-card">
          <CardTitle title="Messaging that performed best" subtitle={`Connection request copy, ranked by acceptance rate · campaigns over ${RANKABLE_MINIMUM} requests sent`}/>
          {messaging.length ? messaging.map((campaign) => (
            <button type="button" className="messaging-row" key={campaign.campaignId} onClick={() => setSelectedCampaign(campaign)}>
              <span className="messaging-rates">
                <data>{campaign.acceptanceRate.toFixed(1)}%</data>
                <small>accepted</small>
                <data>{campaign.replyRate.toFixed(1)}%</data>
                <small>replied</small>
              </span>
              <span className="messaging-copy">
                <strong>{campaign.name}</strong>
                <q>{excerpt(campaign.firstTouch)}</q>
              </span>
            </button>
          )) : <p className="empty-state">Campaign copy is still being collected.</p>}
        </section>

        <section className="analytics-card campaign-metrics-card">
          <header className="campaign-list-header">
            <div>
              <h2>All campaigns</h2>
              <p>{clientCampaigns.length} campaign{clientCampaigns.length === 1 ? "" : "s"} tracked for {detail.name}</p>
            </div>
            <label className="campaign-sort">
              <span>Sort by</span>
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                {sortOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
          </header>
          <div className="campaign-table-head">
            <span>CAMPAIGN</span><span>LAUNCHED</span><span>REPLY RATE</span><span>ACCEPTED</span><span>POSITIVE</span><span>REPLIES</span><span />
          </div>
          <div className="campaign-metrics-list">
            {sortedCampaigns.map((campaign) => (
              <button key={campaign.campaignId} onClick={() => setSelectedCampaign(campaign)}>
                <span className="campaign-name"><strong>{campaign.name}</strong>{campaign.status ? <small>{campaign.status.replace(/_/g, " ").toLowerCase()}</small> : null}</span>
                <span className="campaign-launched">{launchDate(campaign.launchedAt)}</span>
                <data className="campaign-rate primary">{campaign.replyRate.toFixed(1)}<i>%</i></data>
                <data className="campaign-rate">{campaign.acceptanceRate.toFixed(1)}<i>%</i></data>
                <data className="campaign-rate">{campaign.positiveReplyRate.toFixed(1)}<i>%</i></data>
                <span className="campaign-count">{campaign.replies.toLocaleString()}</span>
                <b>›</b>
              </button>
            ))}
          </div>
          {!clientCampaigns.length && <p className="empty-state">{clientPayload ? "No campaigns found for this client." : "Loading campaigns…"}</p>}
        </section>
      </main>
      {activeCampaign && (
        <div className="campaign-modal-backdrop">
          <button
            type="button"
            className="campaign-modal-dismiss"
            aria-label="Close campaign details"
            onClick={closeCampaign}
          />
          <div className="campaign-modal" role="dialog" aria-modal="true" aria-label={activeCampaign.name}>
            <header>
              <div>
                <span>{launchDate(activeCampaign.launchedAt)}{activeCampaign.status ? ` · ${activeCampaign.status.replace(/_/g, " ").toLowerCase()}` : ""}</span>
                <h3>{activeCampaign.name}</h3>
              </div>
              <button aria-label="Close" onClick={closeCampaign}>×</button>
            </header>
            <div className="campaign-modal-grid">
              <Kpi label="Reply rate" value={`${activeCampaign.replyRate.toFixed(1)}%`}/>
              <Kpi label="Acceptance rate" value={`${activeCampaign.acceptanceRate.toFixed(1)}%`}/>
              <Kpi label="Positive reply rate" value={`${activeCampaign.positiveReplyRate.toFixed(1)}%`}/>
              <Kpi label="Connections sent" value={activeCampaign.connectionsSent.toLocaleString()}/>
              <Kpi label="Connections accepted" value={activeCampaign.connectionsAccepted.toLocaleString()}/>
              <Kpi label="Replies" value={activeCampaign.replies.toLocaleString()}/>
              <Kpi label="Positive replies" value={activeCampaign.positiveReplies.toLocaleString()}/>
              <Kpi label="Messages started" value={activeCampaign.messagesStarted.toLocaleString()}/>
              <Kpi label="Leads in list" value={activeCampaign.totalLeads.toLocaleString()}/>
              <Kpi label="Still to contact" value={activeCampaign.leadsPending.toLocaleString()} sub={activeCampaign.daysLeft ? `about ${activeCampaign.daysLeft} sending day${activeCampaign.daysLeft === 1 ? "" : "s"} left` : undefined}/>
              <Kpi label="Senders assigned" value={activeCampaign.senderIds.length.toLocaleString()}/>
              <Kpi label="Sequence steps" value={activeCampaign.sequenceSteps == null ? "—" : activeCampaign.sequenceSteps.toLocaleString()}/>
            </div>
            {(activeCampaign.firstTouch || activeCampaign.followUp) && (
              <div className="campaign-modal-copy">
                {activeCampaign.firstTouch && <div><span>Connection request</span><p>{activeCampaign.firstTouch}</p></div>}
                {activeCampaign.followUp && <div><span>First message after acceptance</span><p>{activeCampaign.followUp}</p></div>}
              </div>
            )}
          </div>
        </div>
      )}
    </section></div>;
  }

  const trend = data.trend ?? [];
  const max = Math.max(...trend, 1);
  const allCampaigns = data.campaignMetrics ?? [];
  // "Now" is the moment the data was fetched, not the moment React happened to render. It keeps
  // these figures pure and it is the more honest answer anyway: they describe that snapshot.
  const asOf = updatedAt ?? new Date(0);
  const markFor = (workspaceId: string) => workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  /**
   * Every campaign we hold, busiest week first, regardless of whose it is.
   *
   * Ranked on the last seven days rather than lifetime replies. A lifetime ranking is won permanently
   * by whichever campaign ran longest, so the card slowly stopped changing and stopped being worth
   * looking at — the question it should answer is which campaigns are working *now*.
   *
   * Ties on the week are broken by lifetime replies, so a quiet week still lists the campaigns with a
   * track record above ones that have never produced anything.
   */
  const weekly = (row: CampaignMetric) => row.replies7d ?? 0;
  const campaignLeaders = [...allCampaigns]
    .sort((a, b) => weekly(b) - weekly(a) || b.replies - a.replies)
    .slice(0, 8);
  const campaignLeaderMax = Math.max(...campaignLeaders.map(weekly), 1);
  /**
   * How long each client has been with us, from the launch date of their first campaign.
   *
   * HeyReach is the only record of when work actually started — a workspace can be created
   * weeks before anything goes out — so a client with no launch dates is left out rather than
   * shown as a day old.
   */
  const engagements = workspaces
    .map((workspace) => {
      const stamps = allCampaigns
        .filter((campaign) => campaign.workspaceId === workspace.id)
        .map((campaign) => (campaign.launchedAt ? new Date(campaign.launchedAt).getTime() : NaN))
        .filter((stamp) => Number.isFinite(stamp));
      if (!stamps.length) return null;
      const first = Math.min(...stamps);
      return { workspace, first, days: Math.max(0, Math.floor((asOf.getTime() - first) / 86_400_000)) };
    })
    .filter((row): row is { workspace: WorkspaceDetail; first: number; days: number } => row !== null)
    .sort((a, b) => b.days - a.days);
  const longestEngagement = Math.max(...engagements.map((row) => row.days), 1);
  const monthStart = new Date(asOf.getFullYear(), asOf.getMonth(), 1).getTime();
  const launchedThisMonth = workspaces
    .map((workspace) => ({
      workspace,
      count: allCampaigns.filter(
        (campaign) =>
          campaign.workspaceId === workspace.id &&
          campaign.launchedAt !== null &&
          new Date(campaign.launchedAt).getTime() >= monthStart,
      ).length,
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);
  const launchedTotal = launchedThisMonth.reduce((sum, row) => sum + row.count, 0);
  const launchedMax = Math.max(...launchedThisMonth.map((row) => row.count), 1);
  const thisMonthLabel = asOf.toLocaleDateString("en-US", { month: "long" });
  // The dates are stamped server-side so the bars stay labelled with real days rather than
  // "6d ago" offsets that quietly went wrong once the window grew past a week.
  const trendLabels = data.trendLabels ?? [];
  return <div className="app-shell"><AppSidebar/><section className="main-area"><header className="topbar"><Crumb trail={[{ label: "Analytics" }]} /><div className="top-actions"><GlobalAppearanceControl /></div></header><main className="analytics-dashboard"><header className="analytics-hero"><div><h1>Analytics</h1></div><div className="analytics-live"><i /> Live data{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</div></header>
    <section className="analytics-kpis"><Kpi label="All-time replies" value={(data.totalReplies ?? 0).toLocaleString()} sub="Across all clients"/><Kpi label="Average reply rate" value={`${(data.campaignAverages?.replyRate ?? 0).toFixed(1)}%`} sub="Across all clients"/><Kpi label="Average acceptance rate" value={`${(data.campaignAverages?.acceptanceRate ?? 0).toFixed(1)}%`} sub="Across all clients"/><Kpi label="Average positive reply rate" value={`${(data.campaignAverages?.positiveReplyRate ?? 0).toFixed(1)}%`} sub="Across all clients"/><Kpi label="Average daily replies" value={Math.round(data.averageDailyReplies ?? 0).toLocaleString()} sub="Last 7 full days"/></section>
    <section className="analytics-primary"><article className="analytics-card analytics-trend"><CardTitle title="Reply momentum"/><div className="analytics-bars">{trend.map((value, index) => <div key={index}><strong>{value}</strong><i style={{ height: `${Math.max(4, (value / max) * 100)}%` }}/><small>{trendLabels[index]}</small></div>)}</div></article></section>

    <section className="analytics-clients-section">
      <CardTitle title="Client workspaces"/>
      <div className="analytics-client-grid">
        {workspaces.map((workspace) => {
          const campaigns = (data.campaignMetrics ?? []).filter((campaign) => campaign.workspaceId === workspace.id);
          return <button key={workspace.id} className="analytics-client-card" onClick={() => openClient(workspace.slug)}>
            <div className="analytics-client-card-top"><i style={workspace.logoUrl ? undefined : { background: workspace.accentColor || "var(--accent)" }}>{workspace.logoUrl ? <img src={workspace.logoUrl} alt="" /> : workspace.name[0]}</i></div>
            <h3>{workspace.name}</h3>
            <div className="analytics-client-card-stats"><span>{campaigns.length} campaigns</span></div>
          </button>;
        })}
        {!workspaces.length && <p className="empty-state">No workspaces found.</p>}
      </div>
    </section>

    <section className="analytics-grid">
      <article className="analytics-card analytics-ranking">
        <CardTitle title="Campaign performance across all clients" subtitle="Replies in the last 7 days"/>
        {campaignLeaders.length ? campaignLeaders.map((row, index) => (
          <div className="analytics-rank has-mark" key={row.campaignId}>
            <b>{index + 1}</b>
            <ClientMark workspace={markFor(row.workspaceId)} name={row.client}/>
            <span>
              <strong>{row.name}</strong>
              <small>{row.client}</small>
              <i><em style={{ width: `${(weekly(row) / campaignLeaderMax) * 100}%` }}/></i>
            </span>
            <data>{weekly(row)}</data>
          </div>
        )) : <p className="empty-state">No campaign data yet.</p>}
      </article>

      {/* Not a ranking of anything a client did — a ranking of how long we have been at it,
          which is the context every other number on this page is read against. */}
      <article className="analytics-card analytics-ranking">
        <CardTitle title="Engagement duration" subtitle="Measured from each client's first campaign launch"/>
        {engagements.length ? engagements.map((row) => (
          <div className="analytics-rank has-mark no-index" key={row.workspace.id}>
            <ClientMark workspace={row.workspace} name={row.workspace.name}/>
            <span>
              <strong>{row.workspace.name}</strong>
              <small>Since {launchDate(new Date(row.first).toISOString())}</small>
              <i><em style={{ width: `${(row.days / longestEngagement) * 100}%` }}/></i>
            </span>
            <data>{durationLabel(row.days)}</data>
          </div>
        )) : <p className="empty-state">No launch dates available from HeyReach.</p>}
      </article>

      <article className="analytics-card analytics-ranking">
        <CardTitle title="Campaigns launched this month" subtitle={`${thisMonthLabel} to date, by client`}/>
        <div className="analytics-launch-total">
          <strong>{launchedTotal}</strong>
          <span>launched across {launchedThisMonth.length} client{launchedThisMonth.length === 1 ? "" : "s"}</span>
        </div>
        {launchedThisMonth.length ? launchedThisMonth.map((row) => (
          <div className="analytics-rank has-mark no-index" key={row.workspace.id}>
            <ClientMark workspace={row.workspace} name={row.workspace.name}/>
            <span>
              <strong>{row.workspace.name}</strong>
              <i><em style={{ width: `${(row.count / launchedMax) * 100}%` }}/></i>
            </span>
            <data>{row.count}</data>
          </div>
        )) : <p className="empty-state">Nothing launched yet this month.</p>}
      </article>
    </section>
  </main></section></div>;
}
function Kpi({ label, value, sub }: { label: string; value: string | number | undefined; sub?: string }) { return <div className="analytics-kpi"><span>{label}</span><strong>{value ?? "—"}</strong>{sub ? <small>{sub}</small> : null}</div>; }
function CardTitle({ title, subtitle }: { title: string; subtitle?: string }) { return <header className="analytics-card-title"><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</header>; }
/** A client's logo at row scale, falling back to their accent colour and initial. */
function ClientMark({ workspace, name }: { workspace: WorkspaceDetail | null; name: string }) {
  return <i className="analytics-mark" style={workspace?.logoUrl ? undefined : { background: workspace?.accentColor || "var(--accent)" }} aria-hidden="true">{workspace?.logoUrl ? <img src={workspace.logoUrl} alt=""/> : (name || "?")[0].toUpperCase()}</i>;
}
