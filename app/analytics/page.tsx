"use client";

import { useEffect, useState } from "react";
import AppSidebar from "../components/AppSidebar";

type AnalyticsData = { status?: string; totalReplies?: number; replies7d?: number; trend?: number[]; clientLoad?: Array<{ name: string; leads: number }> };

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData>({});
  useEffect(() => { fetch("/api/analytics", { cache: "no-store" }).then((response) => response.json()).then(setData).catch(() => setData({ status: "error" })); }, []);
  const trend = data.trend ?? [];
  const max = Math.max(...trend, 1);
  return <div className="app-shell"><AppSidebar/><section className="main-area"><header className="topbar"><div className="crumb"><span>Reply Radar</span><strong>› Analytics</strong></div></header><main className="admin-shell analytics-shell"><section className="admin-content"><div className="admin-heading"><div><div className="eyebrow"><span className="live-dot"/>PERFORMANCE</div><h1>Analytics</h1><p>Live metrics from connected workspaces.</p></div></div><div className="workspace-cards"><Stat label="Replies · 7 days" value={data.replies7d == null ? "—" : String(data.replies7d)} /><Stat label="Total replies" value={data.totalReplies == null ? "—" : String(data.totalReplies)} /><Stat label="Workspaces" value={data.clientLoad == null ? "—" : String(data.clientLoad.length)} /></div><div className="admin-grid"><section className="admin-panel"><div className="panel-heading"><div><h2>Reply activity</h2><p>Daily message volume from synced data.</p></div><span className="saved-dot">{data.status ?? "Loading"}</span></div>{trend.length ? <div className="bar-chart">{trend.map((value, index) => <div key={index} className="bar-col"><i style={{ height: `${(value / max) * 100}%` }} /><small>{index + 1}</small></div>)}</div> : <p className="empty-state">No synced analytics data is available yet.</p>}</section><section className="admin-panel"><div className="panel-heading"><div><h2>Workspace comparison</h2><p>Conversation volume by workspace.</p></div></div>{data.clientLoad?.length ? data.clientLoad.map((item) => <div className="timeline-row" key={item.name}><i style={{ background: "var(--accent)" }} /><span><strong>{item.name}</strong><small>{item.leads} conversations</small></span></div>) : <p className="empty-state">No workspace data is available yet.</p>}</section></div></section></main></section></div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="workspace-card"><div className="workspace-card-top"><span className="health-state ready">LIVE</span></div><strong>{value}</strong><small>{label}</small></div>; }
