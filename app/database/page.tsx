"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";

type Workspace = { id: string; name: string; slug: string; logoUrl?: string | null; accentColor?: string | null };
type Lead = { id: string; name: string; role: string; company: string; linkedinId?: string | null; profileUrl?: string | null; photoUrl?: string | null; companyPhotoUrl?: string | null; email?: string | null; location?: string | null; headline?: string | null; industry?: unknown; campaignName?: string | null; campaignNames?: string[]; enriched?: boolean; tags: string[]; senderName: string; senderNames?: string[]; workspace: Workspace; createdAt: string; conversationCount: number; replyCount: number; lastReplyAt?: string | null; lastMessage: string; rawData: Record<string, unknown> };
type Detail = { lead: Record<string, unknown>; relatedLeads?: Array<Record<string, unknown>>; workspace: Record<string, unknown> | null; workspaces?: Array<Record<string, unknown>>; conversations: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>>; hasMoreMessages: boolean; nextMessageOffset: number | null };

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
const when = (value: unknown) => value ? new Date(String(value)).toLocaleString() : "—";
const display = (value: unknown) => value == null || value === "" ? "—" : String(value);
const nested = (value: unknown, key: string) => value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>)[key] && typeof (value as Record<string, unknown>)[key] === "object" ? (value as Record<string, unknown>)[key] as Record<string, unknown> : {};
const asObject = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asList = (value: unknown) => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const humanize = (value: unknown) => text(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const uniqueText = (values: unknown[]) => [...new Set(values.map(text).filter(Boolean))];
const locationText = (value: unknown) => {
  if (typeof value === "string") return value;
  const row = asObject(value);
  return text(row.short) || text(row.default) || uniqueText([row.city, row.state, row.country]).join(", ");
};
const timeZoneSuffix: Record<string, string> = { "America/New_York": "EST", "America/Chicago": "CST", "America/Denver": "MST", "America/Los_Angeles": "PST", "Pacific/Honolulu": "HST", UTC: "UTC" };
const dateParts = (value: unknown, timeZone: string) => {
  if (!value) return { date: "—", time: "" };
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return { date: "—", time: "" };
  return { date: parsed.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }), time: `${parsed.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })} ${timeZoneSuffix[timeZone] ?? ""}`.trim() };
};
const senderNameFrom = (...values: unknown[]) => {
  for (const value of values) {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const metadata = raw.reply_radar && typeof raw.reply_radar === "object" ? raw.reply_radar as Record<string, unknown> : {};
    const sender = metadata.sender && typeof metadata.sender === "object" ? metadata.sender as Record<string, unknown> : {};
    if (sender.name) return String(sender.name);
  }
  return "Unknown sender";
};
const campaignNameFrom = (...values: unknown[]) => {
  for (const value of values) {
    const raw = asObject(value);
    const campaign = asObject(asObject(raw.reply_radar).campaign);
    if (campaign.name) return String(campaign.name);
  }
  return "No campaign name";
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
  const [detailTab, setDetailTab] = useState<"overview" | "activity">("overview");
  const [timeZone] = useState(() => {
    if (typeof window === "undefined") return "America/New_York";
    try {
      const saved = JSON.parse(window.localStorage.getItem("reply-radar-prefs:general") || "{}");
      return saved?.appearance?.timeZone ? String(saved.appearance.timeZone) : "America/New_York";
    } catch { return "America/New_York"; }
  });

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

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("lead");
    if (/^[0-9a-f-]{36}$/i.test(requested || "")) window.setTimeout(() => { void openLead(String(requested)); }, 0);
  // A URL deep link should open once on arrival, not refetch whenever local drawer state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <header className="topbar"><div className="crumb"><span>Reply Radar</span><strong>› Lead database</strong></div><div className="top-actions"><div className="database-record-count">{leads.length} loaded</div><GlobalAppearanceControl /></div></header>
        <main className="database-shell" aria-label="Lead database">
          <div className="database-heading"><div><div className="eyebrow"><span className="live-dot" /> REPLY ARCHIVE</div><h1>Lead database</h1><p>Every lead who has replied through HeyReach, with their complete history and original payload.</p></div><button className="secondary-button" onClick={() => load(false)}>Refresh ↻</button></div>
          <section className="database-toolbar">
            <label className="database-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, company, role, or LinkedIn ID…" /></label>
            <label><span>Client</span><select value={workspace} onChange={(event) => setWorkspace(event.target.value)}><option value="">All clients</option>{workspaces.map((item) => <option value={item.slug} key={item.id}>{item.name}</option>)}</select></label>
            {(workspace || search) && <button className="text-button" onClick={() => { setWorkspace(""); setSearch(""); }}>Clear filters</button>}
          </section>
          {error && <div className="database-error">{error}</div>}
          <section className="database-table-card">
            <div className="database-table-head"><span>Lead</span><span>Client</span><span>Campaign</span><span>Sender</span><span>Replies</span><span>Date and time</span><span /></div>
            {loading ? <DatabaseSkeleton /> : leads.length ? leads.map((lead) => <button className="database-row" key={lead.id} onClick={() => openLead(lead.id)}>
              <span className="database-person"><i style={{ background: lead.workspace?.accentColor || "var(--accent)" }}>{lead.photoUrl ? <img src={lead.photoUrl} alt="" /> : initials(lead.name)}</i><span><strong>{lead.name}</strong><small>{[lead.role, lead.company].filter(Boolean).join(" · ") || "No title or company"}</small></span></span>
              <span className="database-client">{lead.workspace?.logoUrl ? <i><img src={lead.workspace.logoUrl} alt="" /></i> : <i style={{ background: lead.workspace?.accentColor || "var(--accent)" }}>{lead.workspace?.name?.[0] || "?"}</i>}<b>{lead.workspace?.name || "Unknown"}</b></span>
              <span className="database-campaign"><b>{lead.campaignNames?.join("; ") || lead.campaignName || "—"}</b></span>
              <span className="database-sender"><b>{lead.senderNames?.join("; ") || lead.senderName}</b></span>
              <span className="database-reply-count"><b>{lead.replyCount}</b></span>
              <span className="database-date"><b>{dateParts(lead.lastReplyAt, timeZone).date}</b><small>{dateParts(lead.lastReplyAt, timeZone).time}</small></span><span className="database-arrow">→</span>
            </button>) : <div className="database-empty"><strong>No matching leads</strong><span>New replies will appear here automatically after webhook processing.</span></div>}
          </section>
          {hasMore && <button className="database-load-more" disabled={loadingMore} onClick={() => load(true, cursor)}>{loadingMore ? "Loading…" : "Load 50 more leads"}</button>}
        </main>
      </section>
      {selectedId && <div className="database-drawer-backdrop"><aside className="database-drawer" aria-label="Lead details">
        <div className="database-drawer-head"><div>{selectedSummary?.photoUrl ? <i><img src={selectedSummary.photoUrl} alt="" /></i> : <i>{initials(selectedSummary?.name || "")}</i>}<span><small>LEAD RECORD</small><h2>{selectedSummary?.name || "Loading…"}</h2><p>{[selectedSummary?.role, selectedSummary?.company].filter(Boolean).join(" · ")}</p></span></div><button onClick={() => setSelectedId(null)} aria-label="Close lead details">×</button></div>
        <nav className="database-tabs">{(["overview", "activity"] as const).map((tab) => <button className={detailTab === tab ? "active" : ""} key={tab} onClick={() => setDetailTab(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
        <div className="database-drawer-body">{detailLoading ? <DatabaseSkeleton /> : detail && detailTab === "overview" ? <LeadOverview detail={detail} /> : detail && detailTab === "activity" ? <LeadActivity detail={detail} onLoadOlder={loadOlderMessages} /> : null}</div>
      </aside></div>}
    </div>
  );
}

function LeadOverview({ detail }: { detail: Detail }) {
  const raw = detail.lead.raw_data && typeof detail.lead.raw_data === "object" ? detail.lead.raw_data as Record<string, unknown> : {};
  const metadata = nested(raw, "reply_radar");
  const enrichment = nested(metadata, "ai_ark");
  const rollup = nested(metadata, "rollup");
  const attributions = asList(metadata.attributions).map(asObject);
  const clients = Array.isArray(rollup.clients) ? rollup.clients.map(String) : uniqueText([...(detail.workspaces ?? []).map((item) => item.name), ...attributions.map((item) => item.workspaceName)]);
  const campaigns = Array.isArray(rollup.campaigns) ? rollup.campaigns.map(String) : uniqueText(attributions.map((item) => item.campaignName));
  const senders = Array.isArray(rollup.senders) ? rollup.senders.map(String) : uniqueText(attributions.map((item) => item.senderName));
  const department = asObject(enrichment.department);
  const departmentLabels = uniqueText([department.seniority, ...asList(department.functions), ...asList(department.departments), ...asList(department.sub_departments)]).map(humanize);
  const statistics = asObject(enrichment.statistics);
  const network = asObject(statistics.network);
  const networkLabels = [network.followers_count ? `${Number(network.followers_count).toLocaleString()} followers` : "", network.connections_count ? `${Number(network.connections_count).toLocaleString()} connections` : ""].filter(Boolean);
  const skills = asList(enrichment.skills).map((item) => typeof item === "string" ? item : text(asObject(item).name || asObject(item).title)).filter(Boolean);
  const languages = languageLabels(enrichment.languages);
  const education = recordLabels(enrichment.educations, ["school_name", "school", "name", "degree_name", "degree", "field_of_study"]);
  const certifications = recordLabels(enrichment.certifications, ["name", "title", "authority", "organization"]);
  const positions = positionLabels(enrichment.positionGroups);
  const company = asObject(enrichment.company);
  const companySummary = asObject(company.summary);
  const companyLabels = uniqueText([company.name, companySummary.name, company.industry, companySummary.industry, company.website, companySummary.website, company.domain, companySummary.domain]);
  const contactFields = [["Full name", detail.lead.name], ["Current role", detail.lead.role || enrichment.title], ["Company", detail.lead.company], ["Email", raw.email_address || raw.custom_email || raw.enriched_email], ["Location", locationText(raw.location || enrichment.location)], ["Industry", enrichment.industry], ["Clients", clients.join("; ")], ["Campaigns", campaigns.join("; ")], ["Senders", senders.join("; ")], ["First reply stored", detail.lead.created_at], ["Last enriched", enrichment.enrichedAt]];
  return <div className="database-overview">
    <section><h3>Contact information</h3><div className="database-field-grid">{contactFields.map(([label, value]) => <ReadableField label={String(label)} value={String(label).includes("reply") || String(label).includes("enriched") ? when(value) : display(value)} key={String(label)} />)}<div><small>LinkedIn profile</small>{detail.lead.linkedin_profile_url ? <a href={String(detail.lead.linkedin_profile_url)} target="_blank" rel="noreferrer">Open LinkedIn ↗</a> : <strong>—</strong>}</div></div></section>
    {Object.keys(enrichment).length > 0 && <section><h3>Professional profile</h3><div className="database-enrichment-images">{Boolean(enrichment.profilePhotoUrl) && <figure><img src={String(enrichment.profilePhotoUrl)} alt="Lead profile" /><figcaption>Lead photo</figcaption></figure>}{Boolean(enrichment.companyPhotoUrl) && <figure><img src={String(enrichment.companyPhotoUrl)} alt="Lead company" /><figcaption>Company logo</figcaption></figure>}</div><div className="database-field-grid"><ReadableField label="Headline" value={display(enrichment.headline)} /><ReadableField label="Seniority and department" value={departmentLabels.join(" · ") || "—"} /><ReadableField label="Network" value={networkLabels.join(" · ") || "—"} /><ReadableField label="Languages" value={languages.join(" · ") || "—"} /><ReadableField label="Company details" value={companyLabels.join(" · ") || "—"} /></div>{skills.length > 0 && <ReadableTags title="Skills" items={skills} />}{positions.length > 0 && <ReadableList title="Experience" items={positions} />}{education.length > 0 && <ReadableList title="Education" items={education} />}{certifications.length > 0 && <ReadableList title="Certifications" items={certifications} />}</section>}
    <section><h3>HeyReach context</h3><div className="database-field-grid"><ReadableField label="About" value={display(raw.about)} /><ReadableField label="Summary" value={display(raw.summary)} /><ReadableField label="Tags" value={Array.isArray(raw.tags) ? raw.tags.join(", ") || "—" : "—"} /></div></section>
    {Array.isArray(raw.lists) && raw.lists.length > 0 && <section><h3>Lists and custom fields</h3><div className="database-readable-list">{raw.lists.map((item, index) => { const row = asObject(item); const custom = asObject(row.custom_fields); return <article key={index}><strong>{display(row.name || `List ${index + 1}`)}</strong>{Object.keys(custom).length > 0 && <dl>{Object.entries(custom).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{display(value)}</dd></div>)}</dl>}</article>; })}</div></section>}
  </div>;
}

function ReadableField({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
function ReadableTags({ title, items }: { title: string; items: string[] }) { return <div className="database-readable-group"><small>{title}</small><div className="database-tag-list">{items.map((item) => <span key={item}>{humanize(item)}</span>)}</div></div>; }
function ReadableList({ title, items }: { title: string; items: string[] }) { return <div className="database-readable-group"><small>{title}</small><ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div>; }
function recordLabels(value: unknown, keys: string[]) { return asList(value).map((item) => { const row = asObject(item); return uniqueText(keys.map((key) => { const candidate = row[key]; return typeof candidate === "object" ? text(asObject(candidate).name || asObject(candidate).title) : candidate; })).join(" · "); }).filter(Boolean); }
function languageLabels(value: unknown) { if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? humanize(item) : uniqueText([asObject(item).language, asObject(item).country, asObject(item).name]).join(" · ")).filter(Boolean); const row = asObject(value); const primary = asObject(row.primary_locale); return uniqueText([primary.language && primary.country ? `${humanize(primary.language)} (${text(primary.country)})` : primary.language, ...asList(row.supported_locales).map((item) => { const locale = asObject(item); return locale.language && locale.country ? `${humanize(locale.language)} (${text(locale.country)})` : humanize(locale.language); })]); }
function positionLabels(value: unknown) { return asList(value).flatMap((item) => { const group = asObject(item); const company = asObject(group.company); const companyName = text(company.name || group.company_name); const positions = asList(group.positions || group.position).map(asObject); if (!positions.length) return companyName ? [companyName] : []; return positions.map((position) => uniqueText([position.title || position.name, companyName, position.location]).join(" · ")).filter(Boolean); }); }

function LeadActivity({ detail, onLoadOlder }: { detail: Detail; onLoadOlder: () => void }) {
  const leadRaw = detail.lead.raw_data && typeof detail.lead.raw_data === "object" ? detail.lead.raw_data : {};
  const orderedMessages = [...detail.messages].sort((a, b) => new Date(String(a.sent_at)).getTime() - new Date(String(b.sent_at)).getTime());
  const clientById = new Map((detail.workspaces ?? []).map((workspace) => [String(workspace.id), String(workspace.name)]));
  return <div className="database-activity"><div className="database-activity-summary"><span><b>{detail.conversations.length}</b> conversations</span><span><b>{detail.messages.length}</b> messages loaded</span><span><b>{(detail.workspaces ?? []).length || 1}</b> clients</span></div>{detail.conversations.map((conversation) => { const conversationMessages = detail.messages.filter((message) => message.conversation_id === conversation.id); const sender = senderNameFrom(...conversationMessages.map((message) => message.raw_data), leadRaw); const campaign = campaignNameFrom(...conversationMessages.map((message) => message.raw_data), leadRaw); return <section key={String(conversation.id)}><h3>{clientById.get(String(conversation.workspace_id)) || "Client"} · {campaign}</h3><small>Sender {sender} · Last activity {when(conversation.last_message_at)} · {conversationMessages.length} messages</small></section>; })}<div className="database-message-list">{orderedMessages.map((message) => <article key={String(message.id)}><div><span className={`database-direction ${message.direction}`}>{String(message.direction)} · {message.direction === "outbound" ? senderNameFrom(message.raw_data, leadRaw) : display(detail.lead.name)}</span><time>{when(message.sent_at)}</time></div><p>{display(message.body)}</p></article>)}</div>{detail.hasMoreMessages && <button className="database-load-more" onClick={onLoadOlder}>Load 100 older messages</button>}</div>;
}
function DatabaseSkeleton() { return <div className="database-skeleton" aria-label="Loading database"><i /><i /><i /><i /><i /></div>; }
