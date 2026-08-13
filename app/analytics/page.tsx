"use client";

import { useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";

type Performance = { name: string; replies: number; messages?: number; messagesSent?: number; conversations?: number; clients?: string[] };
type CampaignMetric = { workspaceId: string; client: string; campaignId: string; name: string; connectionsSent: number; connectionsAccepted: number; replies: number; messagesStarted: number; acceptanceRate: number; replyRate: number; positiveReplies: number; positiveReplyRate: number; launchedAt: string | null; status: string | null };
type WorkspaceDetail = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type AnalyticsData = { status?: string; totalReplies?: number; messagesSent?: number; activeConversations?: number; replies7d?: number; trend?: number[]; trendLabels?: string[]; averageDailyReplies?: number; campaignMetrics?: CampaignMetric[]; campaignAverages?: { replyRate: number; acceptanceRate: number; positiveReplyRate: number }; clientPerformance?: Performance[]; campaigns?: Performance[]; senders?: Performance[]; workspaceDetails?: WorkspaceDetail[] };

const launchDate = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
/** How long we have worked with a client, measured from their first real campaign launch. */
const engagementRuntime = (campaigns: CampaignMetric[]) => {
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
];
const sortCampaigns = (campaigns: CampaignMetric[], sort: string) => {
  // Rows without a launch date always sink to the bottom of date sorts.
  const stamp = (campaign: CampaignMetric) => (campaign.launchedAt ? new Date(campaign.launchedAt).getTime() : NaN);
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
    default:
      return rows.sort((a, b) => (Number.isFinite(stamp(b)) ? stamp(b) : -Infinity) - (Number.isFinite(stamp(a)) ? stamp(a) : -Infinity));
  }
};

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData>({});
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignMetric | null>(null);
  const [sort, setSort] = useState("launch-desc");
  const [copied, setCopied] = useState(false);
  // The campaign name from the URL, resolved against the metrics once they load.
  const [urlCampaign, setUrlCampaign] = useState<string | null>(null);

  useEffect(() => {
    const load = () => fetch("/api/analytics", { cache: "no-store" }).then((response) => response.json()).then((payload) => { setData(payload); setUpdatedAt(new Date()); }).catch(() => setData({ status: "error" }));
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // The client view is addressable so it can be shared, bookmarked, or served from a
  // per-client subdomain (middleware rewrites `<slug>.host` to `/analytics?client=<slug>`).
  useEffect(() => {
    const readSlug = () => {
      const params = new URLSearchParams(window.location.search);
      setSelectedSlug(params.get("client"));
      setUrlCampaign(params.get("campaign"));
    };
    readSlug();
    window.addEventListener("popstate", readSlug);
    return () => window.removeEventListener("popstate", readSlug);
  }, []);
  // Deep links from the inbox carry a campaign name, not an id, because that is all a
  // conversation knows. Matching is derived rather than pushed into state through an
  // effect, so the modal opens on the first render after the metrics arrive. An
  // unrecognised name simply leaves you on the client or index page.
  const linkedCampaign = useMemo(() => {
    if (!urlCampaign) return null;
    const wanted = urlCampaign.trim().toLowerCase();
    return (data.campaignMetrics ?? []).find((campaign) => campaign.name.trim().toLowerCase() === wanted) ?? null;
  }, [urlCampaign, data.campaignMetrics]);
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

  const workspaces = data.workspaceDetails ?? [];
  // A campaign link without ?client= still has to land on that campaign's client.
  const activeSlug = selectedSlug ?? (linkedCampaign ? workspaces.find((workspace) => workspace.id === linkedCampaign.workspaceId)?.slug ?? null : null);
  const clientDetail = activeSlug ? workspaces.find((workspace) => workspace.slug === activeSlug) ?? null : null;
  const clientCampaigns = useMemo(
    () => (clientDetail ? (data.campaignMetrics ?? []).filter((campaign) => campaign.workspaceId === clientDetail.id) : []),
    [clientDetail, data.campaignMetrics],
  );
  const sortedCampaigns = useMemo(() => sortCampaigns(clientCampaigns, sort), [clientCampaigns, sort]);
  const clientPerf = clientDetail ? (data.clientPerformance ?? []).find((row) => row.name === clientDetail.name) : null;

  if (activeSlug && clientDetail) {
    const average = (key: "replyRate" | "acceptanceRate" | "positiveReplyRate") =>
      clientCampaigns.length ? clientCampaigns.reduce((sum, campaign) => sum + campaign[key], 0) / clientCampaigns.length : null;
    // HeyReach reply totals cover the full campaign history, not just what we have synced.
    const allTimeReplies = clientCampaigns.reduce((sum, campaign) => sum + campaign.replies, 0);
    const runtime = engagementRuntime(clientCampaigns);
    // Strip an existing client label so the shown host stays `<slug>.<root domain>`.
    const host = typeof window === "undefined" ? "" : window.location.host;
    const rootHost = host.startsWith(`${clientDetail.slug}.`) ? host.slice(clientDetail.slug.length + 1) : host;
    const shareUrl = `${clientDetail.slug}.${rootHost}`;
    return <div className="app-shell"><AppSidebar/><section className="main-area">
      <header className="topbar"><Crumb trail={[{ label: "Analytics", href: "/analytics", onClick: (event) => { event.preventDefault(); openClient(null); } }, { label: clientDetail.name }]} /><div className="top-actions"><GlobalAppearanceControl /></div></header>
      <main className="analytics-dashboard">
        <header className="analytics-hero client-hero">
          <div className="client-hero-identity">
            <i className="client-hero-logo" style={clientDetail.logoUrl ? undefined : { background: clientDetail.accentColor || "var(--accent)" }}>
              {clientDetail.logoUrl ? <img src={clientDetail.logoUrl} alt={clientDetail.name} /> : clientDetail.name[0]}
            </i>
            <div>
              <button className="analytics-back" onClick={() => openClient(null)}>← All clients</button>
              <h1>{clientDetail.name}</h1>
              <button
                className="client-share-url"
                title="Copy this client's analytics URL"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${window.location.origin}/analytics?client=${encodeURIComponent(clientDetail.slug)}`);
                  setCopied(true);
                }}
              >
                {copied ? "Copied link" : shareUrl}
              </button>
            </div>
          </div>
          <div className="analytics-live"><i /> Live data{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</div>
        </header>
        <section className="analytics-kpis">
          <Kpi label="All-time replies" value={allTimeReplies.toLocaleString()} sub={`${(clientPerf?.replies ?? 0).toLocaleString()} synced to the inbox`}/>
          <Kpi label="Average reply rate" value={average("replyRate") == null ? "—" : `${average("replyRate")!.toFixed(1)}%`}/>
          <Kpi label="Average acceptance rate" value={average("acceptanceRate") == null ? "—" : `${average("acceptanceRate")!.toFixed(1)}%`}/>
          <Kpi label="Average positive reply rate" value={average("positiveReplyRate") == null ? "—" : `${average("positiveReplyRate")!.toFixed(1)}%`}/>
          <Kpi label="Engagement runtime" value={runtime.label} sub={runtime.since}/>
        </section>
        <section className="analytics-card campaign-metrics-card">
          <header className="campaign-list-header">
            <div>
              <h2>Campaigns</h2>
              <p>{clientCampaigns.length} campaign{clientCampaigns.length === 1 ? "" : "s"} tracked for {clientDetail.name}</p>
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
              <button key={`${campaign.workspaceId}:${campaign.campaignId}`} onClick={() => setSelectedCampaign(campaign)}>
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
          {!clientCampaigns.length && <p className="empty-state">No campaigns found for this client.</p>}
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
            </div>
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
  /** Every campaign we hold, best reply count first, regardless of whose it is. */
  const campaignLeaders = [...allCampaigns].sort((a, b) => b.replies - a.replies).slice(0, 8);
  const campaignLeaderMax = Math.max(...campaignLeaders.map((row) => row.replies), 1);
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
    <section className="analytics-kpis"><Kpi label="All-time replies" value={(data.totalReplies ?? 0).toLocaleString()} sub="Across all clients"/><Kpi label="Average reply rate" value={`${(data.campaignAverages?.replyRate ?? 0).toFixed(1)}%`} sub="Across all clients"/><Kpi label="Average acceptance rate" value={`${(data.campaignAverages?.acceptanceRate ?? 0).toFixed(1)}%`} sub="Across all clients"/><Kpi label="Average positive reply rate" value={`${(data.campaignAverages?.positiveReplyRate ?? 0).toFixed(1)}%`} sub="Across all clients"/><Kpi label="Average daily replies" value={(data.averageDailyReplies ?? 0).toFixed(1)} sub="Across all clients"/></section>
    <section className="analytics-primary"><article className="analytics-card analytics-trend"><CardTitle title="Reply momentum" subtitle="Replies over the last 14 days, across all clients"/><div className="analytics-bars">{trend.map((value, index) => <div key={index}><strong>{value}</strong><i style={{ height: `${Math.max(4, (value / max) * 100)}%` }}/><small>{trendLabels[index]}</small></div>)}</div></article></section>

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
        <CardTitle title="Campaign performance across all clients" subtitle="Ranked by reply count"/>
        {campaignLeaders.length ? campaignLeaders.map((row, index) => (
          <div className="analytics-rank has-mark" key={row.campaignId}>
            <b>{index + 1}</b>
            <ClientMark workspace={markFor(row.workspaceId)} name={row.client}/>
            <span>
              <strong>{row.name}</strong>
              <small>{row.client}</small>
              <i><em style={{ width: `${(row.replies / campaignLeaderMax) * 100}%` }}/></i>
            </span>
            <data>{row.replies}</data>
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
