"use client";

import { useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";

type Performance = { name: string; replies: number; messages?: number; messagesSent?: number; conversations?: number; clients?: string[] };
type CampaignMetric = { workspaceId: string; client: string; campaignId: string; name: string; connectionsSent: number; connectionsAccepted: number; replies: number; messagesStarted: number; acceptanceRate: number; replyRate: number; positiveReplies: number; positiveReplyRate: number; launchedAt: string | null; status: string | null };
type WorkspaceDetail = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type AnalyticsData = { status?: string; totalReplies?: number; messagesSent?: number; activeConversations?: number; replies7d?: number; averageResponseMinutes?: number | null; trend?: number[]; queueMix?: { hot: number; warm: number; nurture: number }; campaignMetrics?: CampaignMetric[]; campaignAverages?: { replyRate: number; acceptanceRate: number; positiveReplyRate: number }; aiArkCalls?: number; aiArkSuccesses?: number; aiArkFailures?: number; aiArkTrend?: number[]; aiArkTrendLabels?: string[]; aiArkByClient?: Array<{ name: string; calls: number; successes: number; failures: number }>; clientPerformance?: Performance[]; campaigns?: Performance[]; senders?: Performance[]; workspaceDetails?: WorkspaceDetail[] };

const responseTime = (minutes?: number | null) => minutes == null ? "—" : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

  useEffect(() => {
    const load = () => fetch("/api/analytics", { cache: "no-store" }).then((response) => response.json()).then((payload) => { setData(payload); setUpdatedAt(new Date()); }).catch(() => setData({ status: "error" }));
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // The client view is addressable so it can be shared, bookmarked, or served from a
  // per-client subdomain (middleware rewrites `<slug>.host` to `/analytics?client=<slug>`).
  useEffect(() => {
    const readSlug = () => setSelectedSlug(new URLSearchParams(window.location.search).get("client"));
    readSlug();
    window.addEventListener("popstate", readSlug);
    return () => window.removeEventListener("popstate", readSlug);
  }, []);
  useEffect(() => {
    if (!selectedCampaign) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedCampaign(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedCampaign]);

  const openClient = (slug: string | null) => {
    setSelectedSlug(slug);
    setSelectedCampaign(null);
    setCopied(false);
    const url = slug ? `/analytics?client=${encodeURIComponent(slug)}` : "/analytics";
    window.history.pushState({}, "", url);
  };

  const workspaces = data.workspaceDetails ?? [];
  const clientDetail = selectedSlug ? workspaces.find((workspace) => workspace.slug === selectedSlug) ?? null : null;
  const clientCampaigns = useMemo(
    () => (clientDetail ? (data.campaignMetrics ?? []).filter((campaign) => campaign.workspaceId === clientDetail.id) : []),
    [clientDetail, data.campaignMetrics],
  );
  const sortedCampaigns = useMemo(() => sortCampaigns(clientCampaigns, sort), [clientCampaigns, sort]);
  const clientPerf = clientDetail ? (data.clientPerformance ?? []).find((row) => row.name === clientDetail.name) : null;

  if (selectedSlug && clientDetail) {
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
      <header className="topbar"><div className="crumb"><span>Reply Radar</span><span> › <a className="crumb-link" href="/analytics" onClick={(event) => { event.preventDefault(); openClient(null); }}>Analytics</a></span><strong> › {clientDetail.name}</strong></div><div className="top-actions"><GlobalAppearanceControl /></div></header>
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
      {selectedCampaign && (
        <div className="campaign-modal-backdrop">
          <button
            type="button"
            className="campaign-modal-dismiss"
            aria-label="Close campaign details"
            onClick={() => setSelectedCampaign(null)}
          />
          <div className="campaign-modal" role="dialog" aria-modal="true" aria-label={selectedCampaign.name}>
            <header>
              <div>
                <span>{launchDate(selectedCampaign.launchedAt)}{selectedCampaign.status ? ` · ${selectedCampaign.status.replace(/_/g, " ").toLowerCase()}` : ""}</span>
                <h3>{selectedCampaign.name}</h3>
              </div>
              <button aria-label="Close" onClick={() => setSelectedCampaign(null)}>×</button>
            </header>
            <div className="campaign-modal-grid">
              <Kpi label="Reply rate" value={`${selectedCampaign.replyRate.toFixed(1)}%`}/>
              <Kpi label="Acceptance rate" value={`${selectedCampaign.acceptanceRate.toFixed(1)}%`}/>
              <Kpi label="Positive reply rate" value={`${selectedCampaign.positiveReplyRate.toFixed(1)}%`}/>
              <Kpi label="Connections sent" value={selectedCampaign.connectionsSent.toLocaleString()}/>
              <Kpi label="Connections accepted" value={selectedCampaign.connectionsAccepted.toLocaleString()}/>
              <Kpi label="Replies" value={selectedCampaign.replies.toLocaleString()}/>
              <Kpi label="Positive replies" value={selectedCampaign.positiveReplies.toLocaleString()}/>
              <Kpi label="Messages started" value={selectedCampaign.messagesStarted.toLocaleString()}/>
            </div>
          </div>
        </div>
      )}
    </section></div>;
  }

  const trend = data.trend ?? [];
  const max = Math.max(...trend, 1);
  const trendLabels = ["6d ago", "5d ago", "4d ago", "3d ago", "2d ago", "Yesterday", "Today"];
  return <div className="app-shell"><AppSidebar/><section className="main-area"><header className="topbar"><div className="crumb"><span>Reply Radar</span><strong>› Analytics</strong></div><div className="top-actions"><GlobalAppearanceControl /></div></header><main className="analytics-dashboard"><header className="analytics-hero"><div><h1>Analytics</h1><p>Live performance across every stored HeyReach conversation.</p></div><div className="analytics-live"><i /> Live data{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</div></header>
    <section className="analytics-kpis"><Kpi label="All-time replies" value={(data.totalReplies ?? 0).toLocaleString()}/><Kpi label="Average reply rate" value={`${(data.campaignAverages?.replyRate ?? 0).toFixed(1)}%`}/><Kpi label="Average acceptance rate" value={`${(data.campaignAverages?.acceptanceRate ?? 0).toFixed(1)}%`}/><Kpi label="Average positive reply rate" value={`${(data.campaignAverages?.positiveReplyRate ?? 0).toFixed(1)}%`}/><Kpi label="Average response time" value={responseTime(data.averageResponseMinutes)}/></section>
    <section className="analytics-primary"><article className="analytics-card analytics-trend"><CardTitle title="Reply momentum" subtitle="Replies over the last seven days"/><div className="analytics-bars">{trend.map((value, index) => <div key={index}><strong>{value}</strong><i style={{ height: `${Math.max(4, (value / max) * 100)}%` }}/><small>{trendLabels[index]}</small></div>)}</div></article><article className="analytics-card"><CardTitle title="Queue mix" subtitle="Current conversation priorities"/><div className="queue-mix-list"><Mix label="Hot" value={data.queueMix?.hot ?? 0} tone="hot"/><Mix label="Warm" value={data.queueMix?.warm ?? 0} tone="warm"/><Mix label="Nurture" value={data.queueMix?.nurture ?? 0} tone="nurture"/></div></article></section>

    <section className="analytics-clients-section">
      <CardTitle title="Client workspaces" subtitle="Click a client to view their campaign analytics"/>
      <div className="analytics-client-grid">
        {workspaces.map((workspace) => {
          const perf = (data.clientPerformance ?? []).find((row) => row.name === workspace.name);
          const campaigns = (data.campaignMetrics ?? []).filter((campaign) => campaign.workspaceId === workspace.id);
          return <button key={workspace.id} className="analytics-client-card" onClick={() => openClient(workspace.slug)}>
            <div className="analytics-client-card-top"><i style={workspace.logoUrl ? undefined : { background: workspace.accentColor || "var(--accent)" }}>{workspace.logoUrl ? <img src={workspace.logoUrl} alt="" /> : workspace.name[0]}</i></div>
            <h3>{workspace.name}</h3>
            <div className="analytics-client-card-stats"><span>{(perf?.replies ?? 0).toLocaleString()} replies</span><span>{campaigns.length} campaigns</span></div>
          </button>;
        })}
        {!workspaces.length && <p className="empty-state">No workspaces found.</p>}
      </div>
    </section>

    <section className="analytics-grid"><Ranking title="Client performance" subtitle="Stored conversations and replies" rows={data.clientPerformance ?? []} secondary={(row) => `${row.conversations ?? 0} conversations · ${row.messagesSent ?? 0} messages sent`}/><Ranking title="Campaign performance" subtitle="Replies attributed to each campaign" rows={data.campaigns ?? []} secondary={(row) => row.clients?.join(" · ") || "No client attribution"}/><Ranking title="Sender performance" subtitle="Replies by LinkedIn sender" rows={data.senders ?? []} secondary={(row) => row.clients?.join(" · ") || "No client attribution"}/></section>
    <section className="analytics-card analytics-ai"><CardTitle title="AI Ark enrichment" subtitle="Actual provider calls; cached profiles do not increase this count"/><div className="analytics-ai-summary"><Kpi label="Successful" value={data.aiArkSuccesses}/><Kpi label="Failed" value={data.aiArkFailures}/><Kpi label="Total calls" value={data.aiArkCalls}/></div><div className="analytics-client-usage">{data.aiArkByClient?.map((item) => <div key={item.name}><strong>{item.name}</strong><span>{item.calls} calls</span><em className={item.failures ? "failed" : "healthy"}>{item.failures ? `${item.failures} failed` : "Healthy"}</em></div>)}</div></section>
  </main></section></div>;
}
function Kpi({ label, value, sub }: { label: string; value: string | number | undefined; sub?: string }) { return <div className="analytics-kpi"><span>{label}</span><strong>{value ?? "—"}</strong>{sub ? <small>{sub}</small> : null}</div>; }
function CardTitle({ title, subtitle }: { title: string; subtitle: string }) { return <header className="analytics-card-title"><h2>{title}</h2><p>{subtitle}</p></header>; }
function Mix({ label, value, tone }: { label: string; value: number; tone: string }) { return <div className={`analytics-mix ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }
function Ranking({ title, subtitle, rows, secondary }: { title: string; subtitle: string; rows: Performance[]; secondary: (row: Performance) => string }) { const max = Math.max(...rows.map((row) => row.replies), 1); return <article className="analytics-card analytics-ranking"><CardTitle title={title} subtitle={subtitle}/>{rows.length ? rows.slice(0, 8).map((row, index) => <div className="analytics-rank" key={row.name}><b>{index + 1}</b><span><strong>{row.name}</strong><small>{secondary(row)}</small><i><em style={{ width: `${(row.replies/max)*100}%` }}/></i></span><data>{row.replies}</data></div>) : <p className="empty-state">No live data yet.</p>}</article>; }
