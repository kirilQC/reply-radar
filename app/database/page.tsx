"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";

type Workspace = { id: string; name: string; slug: string; logoUrl?: string | null; accentColor?: string | null };
type Lead = { id: string; name: string; role: string; company: string; linkedinId?: string | null; profileUrl?: string | null; photoUrl?: string | null; companyPhotoUrl?: string | null; email?: string | null; location?: string | null; headline?: string | null; industry?: unknown; campaignName?: string | null; enriched?: boolean; tags: string[]; senderName: string; workspace: Workspace; createdAt: string; conversationCount: number; replyCount: number; lastReplyAt?: string | null; lastMessage: string; rawData: Record<string, unknown> };
type Detail = { lead: Record<string, unknown>; workspace: Record<string, unknown> | null; conversations: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>>; hasMoreMessages: boolean; nextMessageOffset: number | null };

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
const when = (value: unknown) => value ? new Date(String(value)).toLocaleString() : "—";
const display = (value: unknown) => value == null || value === "" ? "—" : String(value);
const nested = (value: unknown, key: string) => value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>)[key] && typeof (value as Record<string, unknown>)[key] === "object" ? (value as Record<string, unknown>)[key] as Record<string, unknown> : {};
const rich = (value: unknown) => typeof value === "string" || typeof value === "number" ? display(value) : value ? JSON.stringify(value, null, 2) : "—";
const senderNameFrom = (...values: unknown[]) => {
  for (const value of values) {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const metadata = raw.reply_radar && typeof raw.reply_radar === "object" ? raw.reply_radar as Record<string, unknown> : {};
    const sender = metadata.sender && typeof metadata.sender === "object" ? metadata.sender as Record<string, unknown> : {};
    if (sender.name) return String(sender.name);
  }
  return "Unknown sender";
};

export default function DatabasePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<"overview" | "activity" | "raw">("overview");

  useEffect(() => { const timer = window.setTimeout(() => setDebouncedSearch(search), 300); return () => window.clearTimeout(timer); }, [search]);

  const load = useCallback(async (append = false, requestedCursor: string | null = null) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (workspace) params.set("workspace", workspace);
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (requestedCursor) params.set("cursor", requestedCursor);
      const response = await fetch(`/api/database/leads?${params}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error ?? "Could not load the lead database."));
      setWorkspaces(Array.isArray(payload.workspaces) ? payload.workspaces : []);
      setLeads((current) => append ? [...current, ...(payload.leads ?? [])] : payload.leads ?? []);
      setCursor(payload.nextCursor ?? null); setHasMore(Boolean(payload.hasMore));
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load the lead database."); }
    finally { setLoading(false); setLoadingMore(false); }
  }, [workspace, debouncedSearch]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(false); }, 0); return () => window.clearTimeout(timer); }, [load]);

  const openLead = async (leadId: string) => {
    setSelectedId(leadId); setDetail(null); setDetailLoading(true); setDetailTab("overview");
    try {
      const response = await fetch(`/api/database/leads/${leadId}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error ?? "Could not load lead details."));
      setDetail(payload);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load lead details."); setSelectedId(null); }
    finally { setDetailLoading(false); }
  };

  const loadOlderMessages = async () => {
    if (!selectedId || detail?.nextMessageOffset == null) return;
    const response = await fetch(`/api/database/leads/${selectedId}?messageOffset=${detail.nextMessageOffset}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) setDetail((current) => current ? { ...current, messages: [...current.messages, ...(payload.messages ?? [])], hasMoreMessages: Boolean(payload.hasMoreMessages), nextMessageOffset: payload.nextMessageOffset ?? null } : current);
  };

  const selectedSummary = useMemo(() => leads.find((lead) => lead.id === selectedId), [leads, selectedId]);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area database-main">
        <header className="topbar"><div className="crumb"><span>Reply Radar</span><strong>› Lead database</strong></div><div className="database-record-count">{leads.length} loaded</div></header>
        <main className="database-shell" aria-label="Lead database">
          <div className="database-heading"><div><div className="eyebrow"><span className="live-dot" /> REPLY ARCHIVE</div><h1>Lead database</h1><p>Every lead who has replied through HeyReach, with their complete history and original payload.</p></div><button className="secondary-button" onClick={() => load(false)}>Refresh ↻</button></div>
          <section className="database-toolbar">
            <label className="database-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, company, role, or LinkedIn ID…" /></label>
            <label><span>Client</span><select value={workspace} onChange={(event) => setWorkspace(event.target.value)}><option value="">All clients</option>{workspaces.map((item) => <option value={item.slug} key={item.id}>{item.name}</option>)}</select></label>
            {(workspace || search) && <button className="text-button" onClick={() => { setWorkspace(""); setSearch(""); }}>Clear filters</button>}
          </section>
          {error && <div className="database-error">{error}</div>}
          <section className="database-table-card">
            <div className="database-table-head"><span>Lead</span><span>Client</span><span>Sender / campaign</span><span>Replies</span><span>Last reply</span><span>Latest message</span><span /></div>
            {loading ? <DatabaseSkeleton /> : leads.length ? leads.map((lead) => <button className="database-row" key={lead.id} onClick={() => openLead(lead.id)}>
              <span className="database-person"><i style={{ background: lead.workspace?.accentColor || "var(--accent)" }}>{lead.photoUrl ? <img src={lead.photoUrl} alt="" /> : initials(lead.name)}</i><span><strong>{lead.name}</strong><small>{[lead.role, lead.company].filter(Boolean).join(" · ") || "No title or company"}</small><em>{lead.email || lead.location || ""}</em></span></span>
              <span className="database-client">{lead.workspace?.logoUrl ? <i><img src={lead.workspace.logoUrl} alt="" /></i> : <i style={{ background: lead.workspace?.accentColor || "var(--accent)" }}>{lead.workspace?.name?.[0] || "?"}</i>}<b>{lead.workspace?.name || "Unknown"}</b></span>
              <span className="database-sender"><b>{lead.senderName}</b><small>{lead.campaignName || "No campaign name"}</small></span>
              <span><b>{lead.replyCount}</b><small>{lead.conversationCount} conversation{lead.conversationCount === 1 ? "" : "s"}</small></span>
              <time>{when(lead.lastReplyAt)}</time><span className="database-preview">{lead.lastMessage || "—"}</span><span className="database-arrow">→</span>
            </button>) : <div className="database-empty"><strong>No matching leads</strong><span>New replies will appear here automatically after webhook processing.</span></div>}
          </section>
          {hasMore && <button className="database-load-more" disabled={loadingMore} onClick={() => load(true, cursor)}>{loadingMore ? "Loading…" : "Load 50 more leads"}</button>}
        </main>
      </section>
      {selectedId && <div className="database-drawer-backdrop"><aside className="database-drawer" aria-label="Lead details">
        <div className="database-drawer-head"><div>{selectedSummary?.photoUrl ? <i><img src={selectedSummary.photoUrl} alt="" /></i> : <i>{initials(selectedSummary?.name || "")}</i>}<span><small>LEAD RECORD</small><h2>{selectedSummary?.name || "Loading…"}</h2><p>{[selectedSummary?.role, selectedSummary?.company].filter(Boolean).join(" · ")}</p></span></div><button onClick={() => setSelectedId(null)} aria-label="Close lead details">×</button></div>
        <nav className="database-tabs">{(["overview", "activity", "raw"] as const).map((tab) => <button className={detailTab === tab ? "active" : ""} key={tab} onClick={() => setDetailTab(tab)}>{tab === "raw" ? "Raw HeyReach data" : tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
        <div className="database-drawer-body">{detailLoading ? <DatabaseSkeleton /> : detail && detailTab === "overview" ? <LeadOverview detail={detail} /> : detail && detailTab === "activity" ? <LeadActivity detail={detail} onLoadOlder={loadOlderMessages} /> : detail ? <pre className="database-json">{JSON.stringify({ lead: detail.lead, workspace: detail.workspace, conversations: detail.conversations, messages: detail.messages }, null, 2)}</pre> : null}</div>
      </aside></div>}
    </div>
  );
}

function LeadOverview({ detail }: { detail: Detail }) {
  const raw = detail.lead.raw_data && typeof detail.lead.raw_data === "object" ? detail.lead.raw_data as Record<string, unknown> : {};
  const metadata = nested(raw, "reply_radar");
  const enrichment = nested(metadata, "ai_ark");
  const campaign = Object.keys(nested(metadata, "campaign")).length ? nested(metadata, "campaign") : nested(raw, "campaign");
  const fields = [["Full name", detail.lead.name], ["Role", detail.lead.role], ["Company", detail.lead.company], ["Sender", senderNameFrom(raw)], ["Campaign", campaign.name], ["Location", raw.location], ["Email", raw.email_address || raw.custom_email || raw.enriched_email], ["LinkedIn ID", detail.lead.linkedin_id], ["Profile", detail.lead.linkedin_profile_url], ["First reply stored", detail.lead.created_at], ["Client", detail.workspace?.name]];
  const enrichedFields = [["Headline", enrichment.headline], ["Title", enrichment.title], ["Industry", enrichment.industry], ["AI Ark person ID", enrichment.providerPersonId], ["Last enriched", enrichment.enrichedAt], ["Provider updated", enrichment.lastUpdated], ["Location", enrichment.location], ["Department / seniority", enrichment.department], ["Network statistics", enrichment.statistics], ["Languages", enrichment.languages], ["Skills", enrichment.skills], ["Education", enrichment.educations], ["Certifications", enrichment.certifications], ["Organizations", enrichment.organizations], ["Positions", enrichment.positionGroups], ["Links", enrichment.links], ["Company intelligence", enrichment.company], ["Member badges", enrichment.memberBadges]];
  return <div className="database-overview"><section><h3>Contact information</h3><div className="database-field-grid">{fields.map(([label, value]) => <div key={String(label)}><small>{String(label)}</small>{String(label) === "Profile" && value ? <a href={String(value)} target="_blank" rel="noreferrer">Open LinkedIn ↗</a> : <strong>{String(label).includes("reply") ? when(value) : display(value)}</strong>}</div>)}</div></section>{Object.keys(enrichment).length > 0 && <section><h3>AI Ark enrichment</h3><div className="database-enrichment-images">{Boolean(enrichment.profilePhotoUrl) && <figure><img src={String(enrichment.profilePhotoUrl)} alt="Lead profile" /><figcaption>Lead photo</figcaption></figure>}{Boolean(enrichment.companyPhotoUrl) && <figure><img src={String(enrichment.companyPhotoUrl)} alt="Lead company" /><figcaption>Company photo</figcaption></figure>}</div><div className="database-field-grid">{enrichedFields.map(([label, value]) => <div key={String(label)}><small>{String(label)}</small><pre className="database-json compact">{rich(value)}</pre></div>)}</div></section>}<section><h3>HeyReach context</h3><div className="database-field-grid"><div><small>About</small><strong>{display(raw.about)}</strong></div><div><small>Summary</small><strong>{display(raw.summary)}</strong></div><div><small>Tags</small><strong>{Array.isArray(raw.tags) ? raw.tags.join(", ") || "—" : "—"}</strong></div><div><small>Campaign</small><strong>{display(campaign.name)}</strong></div></div></section>{Array.isArray(raw.lists) && <section><h3>Lists and custom fields</h3>{raw.lists.map((list, index) => <pre className="database-json compact" key={index}>{JSON.stringify(list, null, 2)}</pre>)}</section>}</div>;
}

function LeadActivity({ detail, onLoadOlder }: { detail: Detail; onLoadOlder: () => void }) {
  const leadRaw = detail.lead.raw_data && typeof detail.lead.raw_data === "object" ? detail.lead.raw_data : {};
  const senderName = senderNameFrom(...detail.messages.map((message) => message.raw_data), leadRaw);
  return <div className="database-activity"><div className="database-activity-summary"><span><b>{detail.conversations.length}</b> conversations</span><span><b>{detail.messages.length}</b> messages loaded</span><span><b>{senderName}</b> sender</span></div>{detail.conversations.map((conversation) => <section key={String(conversation.id)}><h3>Conversation <code>{String(conversation.heyreach_conversation_id || conversation.id)}</code></h3><small>Sender {senderName} · Last activity {when(conversation.last_message_at)} · Score {display(conversation.score)} · Tier {display(conversation.tier)}</small></section>)}<div className="database-message-list">{detail.messages.map((message) => <article key={String(message.id)}><div><span className={`database-direction ${message.direction}`}>{String(message.direction)} · {message.direction === "outbound" ? senderNameFrom(message.raw_data, leadRaw) : display(detail.lead.name)}</span><time>{when(message.sent_at)}</time></div><p>{display(message.body)}</p>{Boolean(message.raw_data) && <details><summary>Raw message</summary><pre className="database-json compact">{JSON.stringify(message.raw_data, null, 2)}</pre></details>}</article>)}</div>{detail.hasMoreMessages && <button className="database-load-more" onClick={onLoadOlder}>Load 100 older messages</button>}</div>;
}
function DatabaseSkeleton() { return <div className="database-skeleton" aria-label="Loading database"><i /><i /><i /><i /><i /></div>; }
