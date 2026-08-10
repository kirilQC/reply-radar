"use client";

import { useEffect, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";

type Performance = { name: string; replies: number; messages?: number; outbound?: number; conversations?: number; clients?: string[] };
type CampaignMetric = { workspaceId: string; client: string; campaignId: string; name: string; connectionsSent: number; connectionsAccepted: number; replies: number; messagesStarted: number; acceptanceRate: number; replyRate: number; positiveReplies: number; positiveReplyRate: number };
type WorkspaceDetail = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type AnalyticsData = { status?: string; totalReplies?: number; outboundMessages?: number; activeConversations?: number; replies7d?: number; averageResponseMinutes?: number | null; trend?: number[]; queueMix?: { hot: number; warm: number; nurture: number }; campaignMetrics?: CampaignMetric[]; campaignAverages?: { replyRate: number; acceptanceRate: number; positiveReplyRate: number }; aiArkCalls?: number; aiArkSuccesses?: number; aiArkFailures?: number; aiArkTrend?: number[]; aiArkTrendLabels?: string[]; aiArkByClient?: Array<{ name: string; calls: number; successes: number; failures: number }>; clientPerformance?: Performance[]; campaigns?: Performance[]; senders?: Performance[]; workspaceDetails?: WorkspaceDetail[] };
const responseTime = (minutes?: number | null) => minutes == null ? "—" : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData>({});
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignMetric | null>(null);
  useEffect(() => { const load = () => fetch("/api/analytics", { cache: "no-store" }).then((response) => response.json()).then((payload) => { setData(payload); setUpdatedAt(new Date()); }).catch(() => setData({ status: "error" })); void load(); const timer = window.setInterval(load, 30_000); return () => window.clearInterval(timer); }, []);
  const trend = data.trend ?? [];
  const max = Math.max(...trend, 1);
  const trendLabels = ["6d ago", "5d ago", "4d ago", "3d ago", "2d ago", "Yesterday", "Today"];
  const workspaces = data.workspaceDetails ?? [];
  const clientCampaigns = selectedClient ? (data.campaignMetrics ?? []).filter((c) => c.workspaceId === selectedClient) : [];
  const clientDetail = selectedClient ? workspaces.find((w) => w.id === selectedClient) : null;
  const clientPerf = selectedClient ? (data.clientPerformance ?? []).find((p) => p.name === clientDetail?.name) : null;

  if (selectedClient && clientDetail) {
    const clientAvg = clientCampaigns.length ? {
      replyRate: clientCampaigns.reduce((s, c) => s + c.replyRate, 0) / clientCampaigns.length,
      acceptanceRate: clientCampaigns.reduce((s, c) => s + c.acceptanceRate, 0) / clientCampaigns.length,
      positiveReplyRate: clientCampaigns.reduce((s, c) => s + c.positiveReplyRate, 0) / clientCampaigns.length,
    } : null;
    return <div className="app-shell"><AppSidebar/><section className="main-area"><header className="topbar"><div className="crumb"><span>Reply Radar</span><span> › <a className="crumb-link" href="/analytics" onClick={(e) => { e.preventDefault(); setSelectedClient(null); setSelectedCampaign(null); }}>Analytics</a></span><strong> › {clientDetail.name}</strong></div><div className="top-actions"><GlobalAppearanceControl /></div></header><main className="analytics-dashboard">
      <header className="analytics-hero"><div><button className="analytics-back" onClick={() => { setSelectedClient(null); setSelectedCampaign(null); }}>← Back to all clients</button><h1>{clientDetail.name}</h1><p>Campaign analytics for {clientDetail.name}</p></div><div className="analytics-live"><i /> Live data{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</div></header>
      <section className="analytics-kpis">
        <Kpi label="Conversations" value={clientPerf?.conversations ?? 0}/>
        <Kpi label="Inbound replies" value={clientPerf?.replies ?? 0}/>
        <Kpi label="Outbound messages" value={clientPerf?.outbound ?? 0}/>
        <Kpi label="Avg reply rate" value={clientAvg ? `${clientAvg.replyRate.toFixed(1)}%` : "—"}/>
        <Kpi label="Avg acceptance rate" value={clientAvg ? `${clientAvg.acceptanceRate.toFixed(1)}%` : "—"}/>
      </section>
      <section className="analytics-card campaign-metrics-card"><CardTitle title="Campaigns" subtitle={`${clientCampaigns.length} campaign${clientCampaigns.length === 1 ? "" : "s"} tracked for ${clientDetail.name}`}/><div className="campaign-metrics-list">{clientCampaigns.map((campaign) => <button key={`${campaign.workspaceId}:${campaign.campaignId}`} onClick={() => setSelectedCampaign(campaign)}><span><strong>{campaign.name}</strong><small>{campaign.replies} replies</small></span><data>{campaign.replyRate.toFixed(1)}% reply</data><data>{campaign.acceptanceRate.toFixed(1)}% accepted</data><b>→</b></button>)}</div>{!clientCampaigns.length && <p className="empty-state">No campaigns found for this client.</p>}{selectedCampaign && <div className="campaign-metric-detail"><button className="campaign-detail-close" onClick={() => setSelectedCampaign(null)}>×</button><h3>{selectedCampaign.name}</h3><div><Kpi label="Connections sent" value={selectedCampaign.connectionsSent}/><Kpi label="Connections accepted" value={selectedCampaign.connectionsAccepted}/><Kpi label="Replies" value={selectedCampaign.replies}/><Kpi label="Positive replies" value={selectedCampaign.positiveReplies}/><Kpi label="Reply rate" value={`${selectedCampaign.replyRate.toFixed(1)}%`}/><Kpi label="Acceptance rate" value={`${selectedCampaign.acceptanceRate.toFixed(1)}%`}/><Kpi label="Positive reply rate" value={`${selectedCampaign.positiveReplyRate.toFixed(1)}%`}/></div></div>}</section>
    </main></section></div>;
  }

  return <div className="app-shell"><AppSidebar/><section className="main-area"><header className="topbar"><div className="crumb"><span>Reply Radar</span><strong>› Analytics</strong></div><div className="top-actions"><GlobalAppearanceControl /></div></header><main className="analytics-dashboard"><header className="analytics-hero"><div><h1>Analytics</h1><p>Live performance across every stored HeyReach conversation.</p></div><div className="analytics-live"><i /> Live data{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</div></header>
    <section className="analytics-kpis"><Kpi label="Inbound replies" value={data.totalReplies}/><Kpi label="Average reply rate" value={`${(data.campaignAverages?.replyRate ?? 0).toFixed(1)}%`}/><Kpi label="Average acceptance rate" value={`${(data.campaignAverages?.acceptanceRate ?? 0).toFixed(1)}%`}/><Kpi label="Average positive reply rate" value={`${(data.campaignAverages?.positiveReplyRate ?? 0).toFixed(1)}%`}/><Kpi label="Average response time" value={responseTime(data.averageResponseMinutes)}/></section>
    <section className="analytics-primary"><article className="analytics-card analytics-trend"><CardTitle title="Reply momentum" subtitle="Inbound replies over the last seven days"/><div className="analytics-bars">{trend.map((value, index) => <div key={index}><strong>{value}</strong><i style={{ height: `${Math.max(4, (value / max) * 100)}%` }}/><small>{trendLabels[index]}</small></div>)}</div></article><article className="analytics-card"><CardTitle title="Queue mix" subtitle="Current conversation priorities"/><div className="queue-mix-list"><Mix label="Hot" value={data.queueMix?.hot ?? 0} tone="hot"/><Mix label="Warm" value={data.queueMix?.warm ?? 0} tone="warm"/><Mix label="Nurture" value={data.queueMix?.nurture ?? 0} tone="nurture"/></div></article></section>

    <section className="analytics-clients-section">
      <CardTitle title="Client workspaces" subtitle="Click a client to view their campaign analytics"/>
      <div className="analytics-client-grid">
        {workspaces.map((workspace) => {
          const perf = (data.clientPerformance ?? []).find((p) => p.name === workspace.name);
          const campaigns = (data.campaignMetrics ?? []).filter((c) => c.workspaceId === workspace.id);
          return <button key={workspace.id} className="analytics-client-card" onClick={() => { setSelectedClient(workspace.id); setSelectedCampaign(null); }}>
            <div className="analytics-client-card-top"><i style={workspace.logoUrl ? undefined : { background: workspace.accentColor || "var(--accent)" }}>{workspace.logoUrl ? <img src={workspace.logoUrl} alt="" /> : workspace.name[0]}</i></div>
            <h3>{workspace.name}</h3>
            <div className="analytics-client-card-stats"><span>{perf?.replies ?? 0} replies</span><span>{campaigns.length} campaigns</span></div>
          </button>;
        })}
        {!workspaces.length && <p className="empty-state">No workspaces found.</p>}
      </div>
    </section>

    <section className="analytics-grid"><Ranking title="Client performance" subtitle="Stored conversations and replies" rows={data.clientPerformance ?? []} secondary={(row) => `${row.conversations ?? 0} conversations · ${row.outbound ?? 0} outbound`}/><Ranking title="Campaign performance" subtitle="Replies attributed to each campaign" rows={data.campaigns ?? []} secondary={(row) => row.clients?.join(" · ") || "No client attribution"}/><Ranking title="Sender performance" subtitle="Replies by LinkedIn sender" rows={data.senders ?? []} secondary={(row) => row.clients?.join(" · ") || "No client attribution"}/></section>
    <section className="analytics-card analytics-ai"><CardTitle title="AI Ark enrichment" subtitle="Actual provider calls; cached profiles do not increase this count"/><div className="analytics-ai-summary"><Kpi label="Successful" value={data.aiArkSuccesses}/><Kpi label="Failed" value={data.aiArkFailures}/><Kpi label="Total calls" value={data.aiArkCalls}/></div><div className="analytics-client-usage">{data.aiArkByClient?.map((item) => <div key={item.name}><strong>{item.name}</strong><span>{item.calls} calls</span><em className={item.failures ? "failed" : "healthy"}>{item.failures ? `${item.failures} failed` : "Healthy"}</em></div>)}</div></section>
  </main></section></div>;
}
function Kpi({ label, value }: { label: string; value: string | number | undefined }) { return <div className="analytics-kpi"><span>{label}</span><strong>{value ?? "—"}</strong></div>; }
function CardTitle({ title, subtitle }: { title: string; subtitle: string }) { return <header className="analytics-card-title"><h2>{title}</h2><p>{subtitle}</p></header>; }
function Mix({ label, value, tone }: { label: string; value: number; tone: string }) { return <div className={`analytics-mix ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }
function Ranking({ title, subtitle, rows, secondary }: { title: string; subtitle: string; rows: Performance[]; secondary: (row: Performance) => string }) { const max = Math.max(...rows.map((row) => row.replies), 1); return <article className="analytics-card analytics-ranking"><CardTitle title={title} subtitle={subtitle}/>{rows.length ? rows.slice(0, 8).map((row, index) => <div className="analytics-rank" key={row.name}><b>{index + 1}</b><span><strong>{row.name}</strong><small>{secondary(row)}</small><i><em style={{ width: `${(row.replies/max)*100}%` }}/></i></span><data>{row.replies}</data></div>) : <p className="empty-state">No live data yet.</p>}</article>; }
