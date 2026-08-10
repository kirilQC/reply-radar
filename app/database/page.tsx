"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";

type Workspace = {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string | null;
  accentColor?: string | null;
};
type Lead = {
  id: string;
  name: string;
  role: string;
  company: string;
  linkedinId?: string | null;
  profileUrl?: string | null;
  photoUrl?: string | null;
  companyPhotoUrl?: string | null;
  email?: string | null;
  location?: string | null;
  headline?: string | null;
  industry?: unknown;
  campaignName?: string | null;
  campaignNames?: string[];
  clientCount?: number;
  campaignCount?: number;
  enriched?: boolean;
  tags: string[];
  senderName: string;
  senderNames?: string[];
  workspace: Workspace;
  createdAt: string;
  conversationCount: number;
  replyCount: number;
  lastReplyAt?: string | null;
  lastMessage: string;
  rawData: Record<string, unknown>;
};
type Detail = {
  lead: Record<string, unknown>;
  relatedLeads?: Array<Record<string, unknown>>;
  workspace: Record<string, unknown> | null;
  workspaces?: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  hasMoreMessages: boolean;
  nextMessageOffset: number | null;
};
type FilterOptions = { senders: string[]; campaigns: string[] };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
const when = (value: unknown) =>
  value ? new Date(String(value)).toLocaleString() : "—";
const display = (value: unknown) =>
  value == null || value === "" ? "—" : String(value);
const nested = (value: unknown, key: string) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>)[key] &&
  typeof (value as Record<string, unknown>)[key] === "object"
    ? ((value as Record<string, unknown>)[key] as Record<string, unknown>)
    : {};
const asObject = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asList = (value: unknown) => (Array.isArray(value) ? value : []);
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
const humanize = (value: unknown) =>
  text(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
const uniqueText = (values: unknown[]) => [
  ...new Set(values.map(text).filter(Boolean)),
];
const externalUrl = (value: unknown) => {
  const candidate = text(value);
  if (!candidate) return "";
  return /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
};
const monthYear = (value: unknown) => {
  const candidate = text(value);
  if (!candidate) return "Present";
  const parsed = new Date(`${candidate.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? candidate
    : parsed.toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
};
const durationBetween = (startValue: unknown, endValue: unknown) => {
  const start = new Date(`${text(startValue).slice(0, 10)}T00:00:00Z`);
  const end = text(endValue)
    ? new Date(`${text(endValue).slice(0, 10)}T00:00:00Z`)
    : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  const months = Math.max(
    0,
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      end.getUTCMonth() -
      start.getUTCMonth(),
  );
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  return (
    [
      years ? `${years} yr${years === 1 ? "" : "s"}` : "",
      remainder ? `${remainder} mo${remainder === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" ") || "Less than 1 mo"
  );
};
const locationText = (value: unknown) => {
  if (typeof value === "string") return value;
  const row = asObject(value);
  return (
    text(row.short) ||
    text(row.default) ||
    uniqueText([row.city, row.state, row.country]).join(", ")
  );
};
const timeZoneSuffix: Record<string, string> = {
  "America/New_York": "EST",
  "America/Chicago": "CST",
  "America/Denver": "MST",
  "America/Los_Angeles": "PST",
  "Pacific/Honolulu": "HST",
  UTC: "UTC",
};
const dateParts = (value: unknown, timeZone: string) => {
  if (!value) return { date: "—", time: "" };
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return { date: "—", time: "" };
  return {
    date: parsed.toLocaleDateString("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    time: `${parsed.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })} ${timeZoneSuffix[timeZone] ?? ""}`.trim(),
  };
};
const senderNameFrom = (...values: unknown[]) => {
  for (const value of values) {
    const raw =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const metadata =
      raw.reply_radar && typeof raw.reply_radar === "object"
        ? (raw.reply_radar as Record<string, unknown>)
        : {};
    const sender =
      metadata.sender && typeof metadata.sender === "object"
        ? (metadata.sender as Record<string, unknown>)
        : {};
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
  const [sender, setSender] = useState("");
  const [campaign, setCampaign] = useState("");
  const [timeRange, setTimeRange] = useState("all");
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ senders: [], campaigns: [] });
  const [exporting, setExporting] = useState(false);
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
  const [detailTab, setDetailTab] = useState<"overview" | "activity">(
    "overview",
  );
  const [timeZone] = useState(() => {
    if (typeof window === "undefined") return "America/New_York";
    try {
      const saved = JSON.parse(
        window.localStorage.getItem("reply-radar-prefs:general") || "{}",
      );
      return saved?.appearance?.timeZone
        ? String(saved.appearance.timeZone)
        : "America/New_York";
    } catch {
      return "America/New_York";
    }
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (append = false, requestedCursor: string | null = null) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (workspace) params.set("workspace", workspace);
        if (sender) params.set("sender", sender);
        if (campaign) params.set("campaign", campaign);
        if (timeRange !== "all") params.set("timeRange", timeRange);
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (requestedCursor) params.set("cursor", requestedCursor);
        const response = await fetch(`/api/database/leads?${params}`, {
          cache: "no-store",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(
            String(payload.error ?? "Could not load the lead database."),
          );
        setWorkspaces(
          Array.isArray(payload.workspaces) ? payload.workspaces : [],
        );
        if (!append) setFilterOptions(payload.filterOptions ?? { senders: [], campaigns: [] });
        setLeads((current) =>
          append
            ? [...current, ...(payload.leads ?? [])]
            : (payload.leads ?? []),
        );
        setCursor(payload.nextCursor ?? null);
        setHasMore(Boolean(payload.hasMore));
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load the lead database.",
        );
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [workspace, sender, campaign, timeRange, debouncedSearch],
  );

  const chooseWorkspace = (value: string) => {
    setWorkspace(value);
    setSender("");
    setCampaign("");
    setTimeRange("all");
    setFilterOptions({ senders: [], campaigns: [] });
  };

  const exportCsv = async () => {
    setExporting(true);
    setError("");
    try {
      const exported: Lead[] = [];
      let nextCursor: string | null = null;
      do {
        const params = new URLSearchParams({ limit: "100" });
        if (workspace) params.set("workspace", workspace);
        if (sender) params.set("sender", sender);
        if (campaign) params.set("campaign", campaign);
        if (timeRange !== "all") params.set("timeRange", timeRange);
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (nextCursor) params.set("cursor", nextCursor);
        const response = await fetch(`/api/database/leads?${params}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(payload.error ?? "Could not export leads."));
        exported.push(...(Array.isArray(payload.leads) ? payload.leads : []));
        nextCursor = payload.hasMore ? String(payload.nextCursor || "") : null;
      } while (nextCursor && exported.length < 50_000);
      const columns = ["Lead", "Title", "Company", "Client", "Campaigns", "Senders", "Replies", "Last reply", "LinkedIn"];
      const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const rows = exported.map((lead) => [lead.name, lead.role, lead.company, lead.workspace?.name, lead.campaignNames?.join("; ") || lead.campaignName, lead.senderNames?.join("; ") || lead.senderName, lead.replyCount, lead.lastReplyAt, lead.profileUrl].map(quote).join(","));
      const blob = new Blob([[columns.map(quote).join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `reply-radar-leads-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Could not export leads.");
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const openLead = async (leadId: string) => {
    setSelectedId(leadId);
    setDetail(null);
    setDetailLoading(true);
    setDetailTab("overview");
    try {
      const response = await fetch(`/api/database/leads/${leadId}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          String(payload.error ?? "Could not load lead details."),
        );
      setDetail(payload);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load lead details.",
      );
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const deleteLead = async (leadId: string) => {
    if (!window.confirm("Permanently delete this lead and all their conversations? This cannot be undone.")) return;
    try {
      const response = await fetch(`/api/database/leads/${leadId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      setSelectedId(null);
      setDetail(null);
      void load(false);
    } catch { setError("Could not delete lead."); }
  };

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("lead");
    if (/^[0-9a-f-]{36}$/i.test(requested || ""))
      window.setTimeout(() => {
        void openLead(String(requested));
      }, 0);
    // A URL deep link should open once on arrival, not refetch whenever local drawer state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadOlderMessages = async () => {
    if (!selectedId || detail?.nextMessageOffset == null) return;
    const response = await fetch(
      `/api/database/leads/${selectedId}?messageOffset=${detail.nextMessageOffset}`,
      { cache: "no-store" },
    );
    const payload = await response.json().catch(() => ({}));
    if (response.ok)
      setDetail((current) =>
        current
          ? {
              ...current,
              messages: [...current.messages, ...(payload.messages ?? [])],
              hasMoreMessages: Boolean(payload.hasMoreMessages),
              nextMessageOffset: payload.nextMessageOffset ?? null,
            }
          : current,
      );
  };

  const selectedSummary = useMemo(
    () => leads.find((lead) => lead.id === selectedId),
    [leads, selectedId],
  );

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area database-main">
        <header className="topbar">
          <div className="crumb">
            <span>Reply Radar</span>
            <strong>› Lead database</strong>
          </div>
          <div className="top-actions">
            <GlobalAppearanceControl />
          </div>
        </header>
        <main className="database-shell" aria-label="Lead database">
          <div className="database-heading">
            <div>
              <h1>Lead Database</h1>
              <div className="database-record-count">{leads.length} loaded</div>
            </div>
            <div className="database-heading-actions"><button className="secondary-button" onClick={exportCsv} disabled={exporting}>{exporting ? "Exporting…" : "Export CSV ↓"}</button><button className="secondary-button" onClick={() => load(false)}>Refresh ↻</button></div>
          </div>
          <section className="database-toolbar">
            <label className="database-search">
              <span>⌕</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, company, role, or LinkedIn ID…"
              />
            </label>
            <DatabaseDropdown label="Client" value={workspace} placeholder="All clients" options={workspaces.map((item) => ({ value: item.slug, label: item.name }))} onChange={chooseWorkspace} />
            {workspace && <DatabaseDropdown label="Sender" value={sender} placeholder="All senders" options={filterOptions.senders.map((name) => ({ value: name, label: name }))} onChange={setSender} />}
            {workspace && <DatabaseDropdown label="Campaign" value={campaign} placeholder="All campaigns" options={filterOptions.campaigns.map((name) => ({ value: name, label: name }))} onChange={setCampaign} />}
            {workspace && <DatabaseDropdown label="Time range" value={timeRange} placeholder="All time" options={[{ value: "7d", label: "Last 7 days" }, { value: "14d", label: "Last 14 days" }, { value: "1m", label: "Last month" }, { value: "3m", label: "Last 3 months" }]} onChange={setTimeRange} />}
            {(workspace || search || sender || campaign || timeRange !== "all") && (
              <button
                className="text-button"
                onClick={() => {
                  chooseWorkspace("");
                  setSearch("");
                }}
              >
                Clear filters
              </button>
            )}
          </section>
          {error && <div className="database-error">{error}</div>}
          <section className="database-table-card">
            <div className="database-table-head">
              <span>Lead</span>
              <span>Client</span>
              <span>Campaign</span>
              <span>Sender</span>
              <span>Replies</span>
              <span>Date and time</span>
              <span />
            </div>
            {loading ? (
              <DatabaseSkeleton />
            ) : leads.length ? (
              leads.map((lead) => (
                <button
                  className="database-row"
                  key={lead.id}
                  onClick={() => openLead(lead.id)}
                >
                  <span className="database-person">
                    <i
                      style={{
                        background:
                          lead.workspace?.accentColor || "var(--accent)",
                      }}
                    >
                      {lead.photoUrl ? (
                        <img src={lead.photoUrl} alt="" />
                      ) : (
                        initials(lead.name)
                      )}
                    </i>
                    <span>
                      <strong>{lead.name}</strong>
                      <small>
                        {[lead.role, lead.company]
                          .filter(Boolean)
                          .join(" · ") || "No title or company"}
                      </small>
                    </span>
                  </span>
                  <span className="database-client">
                    {lead.workspace?.logoUrl ? (
                      <i>
                        <img src={lead.workspace.logoUrl} alt="" />
                      </i>
                    ) : (
                      <i
                        style={{
                          background:
                            lead.workspace?.accentColor || "var(--accent)",
                        }}
                      >
                        {lead.workspace?.name?.[0] || "?"}
                      </i>
                    )}
                    <b>{lead.workspace?.name || "Unknown"}</b>
                  </span>
                  <span className="database-campaign">
                    <b>
                      {lead.campaignNames?.join("; ") ||
                        lead.campaignName ||
                        "—"}
                    </b>
                  </span>
                  <span className="database-sender">
                    <b>{lead.senderNames?.join("; ") || lead.senderName}</b>
                  </span>
                  <span className="database-reply-count">
                    <b>{lead.replyCount}</b>
                  </span>
                  <span className="database-date">
                    <b>{dateParts(lead.lastReplyAt, timeZone).date}</b>
                    <small>{dateParts(lead.lastReplyAt, timeZone).time}</small>
                  </span>
                  <span className="database-arrow">→</span>
                </button>
              ))
            ) : (
              <div className="database-empty">
                <strong>No matching leads</strong>
                <span>
                  New replies will appear here automatically after webhook
                  processing.
                </span>
              </div>
            )}
          </section>
          {hasMore && (
            <button
              className="database-load-more"
              disabled={loadingMore}
              onClick={() => load(true, cursor)}
            >
              {loadingMore ? "Loading…" : "Load 50 more leads"}
            </button>
          )}
        </main>
      </section>
      {selectedId && (
        <div className="database-drawer-backdrop">
          <aside className="database-drawer" aria-label="Lead details">
            <div className="database-drawer-head">
              <div>
                {selectedSummary?.photoUrl ? (
                  <i>
                    <img src={selectedSummary.photoUrl} alt="" />
                  </i>
                ) : (
                  <i>{initials(selectedSummary?.name || "")}</i>
                )}
                <span>
                  <h2>{selectedSummary?.name || "Loading…"}</h2>
                </span>
              </div>
              <button
                onClick={() => setSelectedId(null)}
                aria-label="Close lead details"
              >
                ×
              </button>
            </div>
            <nav className="database-tabs">
              {(["overview", "activity"] as const).map((tab) => (
                <button
                  className={detailTab === tab ? "active" : ""}
                  key={tab}
                  onClick={() => setDetailTab(tab)}
                >
                  {tab[0].toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </nav>
            <div className="database-drawer-body">
              {detailLoading ? (
                <DatabaseSkeleton />
              ) : detail && detailTab === "overview" ? (
                <LeadOverview detail={detail} onDelete={() => selectedId && deleteLead(selectedId)} />
              ) : detail && detailTab === "activity" ? (
                <LeadActivity detail={detail} onLoadOlder={loadOlderMessages} />
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function DatabaseDropdown({ label, value, placeholder, options, onChange, disabled = false }: { label: string; value: string; placeholder: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value)?.label;
  return <div className={`database-dropdown ${disabled ? "disabled" : ""}`} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <span>{label}</span>
    <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen((current) => !current)}>{selected || placeholder}<b>⌄</b></button>
    {open && !disabled && <div className="database-dropdown-menu">
      <button type="button" className={!value || value === "all" ? "selected" : ""} onClick={() => { onChange(label === "Time range" ? "all" : ""); setOpen(false); }}>{placeholder}</button>
      {options.map((option) => <button type="button" className={value === option.value ? "selected" : ""} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
    </div>}
  </div>;
}

function LeadOverview({ detail, onDelete }: { detail: Detail; onDelete?: () => void }) {
  const raw =
    detail.lead.raw_data && typeof detail.lead.raw_data === "object"
      ? (detail.lead.raw_data as Record<string, unknown>)
      : {};
  const metadata = nested(raw, "reply_radar");
  const enrichment = nested(metadata, "ai_ark");
  const rollup = nested(metadata, "rollup");
  const relatedRaws = (detail.relatedLeads ?? []).map((item) =>
    asObject(item.raw_data),
  );
  const relatedMetadata = [raw, ...relatedRaws].map((item) =>
    nested(item, "reply_radar"),
  );
  const attributions = relatedMetadata.flatMap((item) =>
    asList(item.attributions).map(asObject),
  );
  const messageMetadata = detail.messages.map((message) =>
    nested(asObject(message.raw_data), "reply_radar"),
  );
  const clients = Array.isArray(rollup.clients)
    ? rollup.clients.map(String)
    : uniqueText([
        ...(detail.workspaces ?? []).map((item) => item.name),
        ...attributions.map((item) => item.workspaceName),
      ]);
  const campaigns = uniqueText([
    ...(Array.isArray(rollup.campaigns) ? rollup.campaigns : []),
    ...attributions.map((item) => item.campaignName),
    ...relatedMetadata.map((item) => asObject(item.campaign).name),
    ...[raw, ...relatedRaws].map((item) => asObject(item.campaign).name),
    ...messageMetadata.map((item) => asObject(item.campaign).name),
  ]);
  const senders = uniqueText([
    ...(Array.isArray(rollup.senders) ? rollup.senders : []),
    ...attributions.map((item) => item.senderName),
    ...relatedMetadata.map((item) => asObject(item.sender).name),
    ...messageMetadata.map((item) => asObject(item.sender).name),
  ]);
  const department = asObject(enrichment.department);
  const departmentLabels = uniqueText([
    department.seniority,
    ...asList(department.functions),
    ...asList(department.departments),
    ...asList(department.sub_departments),
  ]).map(humanize);
  const statistics = asObject(enrichment.statistics);
  const network = asObject(statistics.network);
  const networkLabels = [
    network.followers_count
      ? `${Number(network.followers_count).toLocaleString()} followers`
      : "",
    network.connections_count
      ? `${Number(network.connections_count).toLocaleString()} connections`
      : "",
  ].filter(Boolean);
  const education = recordLabels(enrichment.educations, [
    "school_name",
    "school",
    "name",
    "degree_name",
    "degree",
    "field_of_study",
  ]);
  const company = asObject(enrichment.company);
  const companySummary = asObject(company.summary);
  const companyLinks = asObject(company.link);
  const currentCompanyName = text(
    companySummary.name || company.name || detail.lead.company,
  );
  const companyWebsite = externalUrl(companyLinks.website || raw.company_url);
  const companyLinkedIn = externalUrl(companyLinks.linkedin);
  const companyIndustry = text(
    companySummary.industry || company.industry || enrichment.industry,
  );
  const companyLocation = locationText(asObject(company.location).headquarter);
  const staff = asObject(companySummary.staff);
  const staffRange = asObject(staff.range);
  const companySize =
    staffRange.start || staffRange.end
      ? `${display(staffRange.start || "?")}–${display(staffRange.end || "?")} employees`
      : staff.total
        ? `${Number(staff.total).toLocaleString()} known employees`
        : "";
  const contactFields = [
    ["Full name", detail.lead.name],
    ["Current role", detail.lead.role || enrichment.title],
    ["Company", currentCompanyName],
    ["Email", raw.email_address || raw.custom_email || raw.enriched_email],
    ["Location", locationText(raw.location || enrichment.location)],
    ["Industry", enrichment.industry],
    ["Clients", clients.join("; ")],
    ["Campaigns", campaigns.join("; ")],
    ["Campaign count", rollup.campaign_count || campaigns.length],
    ["Senders", senders.join("; ")],
    ["First reply stored", detail.lead.created_at],
    ["Last enriched", enrichment.enrichedAt],
  ];
  return (
    <div className="database-overview">
      <section>
        <h3>Contact information</h3>
        <div className="database-field-grid">
          {contactFields.map(([label, value]) => (
            <ReadableField
              label={String(label)}
              value={
                String(label).includes("reply") ||
                String(label).includes("enriched")
                  ? when(value)
                  : display(value)
              }
              key={String(label)}
            />
          ))}
          <LinkField
            label="LinkedIn profile"
            href={externalUrl(detail.lead.linkedin_profile_url)}
            text="Open LinkedIn ↗"
          />
          <LinkField
            label="Company website"
            href={companyWebsite}
            text="Open website ↗"
          />
          <LinkField
            label="Company LinkedIn page"
            href={companyLinkedIn}
            text="Open company on LinkedIn ↗"
          />
        </div>
        {Array.isArray(raw.tags) && raw.tags.length > 0 && (
          <ReadableTags title="HeyReach tags" items={raw.tags.map(String)} />
        )}
      </section>
      {Object.keys(enrichment).length === 0 && String(detail.lead.id ?? "") !== "" && (
        <RetryEnrichmentButton leadId={String(detail.lead.id)} />
      )}
      {Object.keys(enrichment).length > 0 && (
        <section>
          <h3>Professional profile</h3>
          <div className="database-field-grid">
            <ReadableField
              label="Headline"
              value={display(enrichment.headline || raw.summary)}
            />
            <ReadableField
              label="Seniority and department"
              value={departmentLabels.join(" · ") || "—"}
            />
            <ReadableField
              label="Network"
              value={networkLabels.join(" · ") || "—"}
            />
          </div>
          <div className="database-about">
            <small>About</small>
            <p>{display(enrichment.summary || raw.about)}</p>
          </div>
        </section>
      )}
      {Object.keys(company).length > 0 && (
        <section>
          <h3>Current company</h3>
          <div className="database-company-card">
            <div className="database-company-heading">
              {Boolean(enrichment.companyPhotoSource || enrichment.companyPhotoUrl) && (
                <img
                  src={String(enrichment.companyPhotoSource || enrichment.companyPhotoUrl)}
                  alt={`${currentCompanyName || "Company"} logo`}
                />
              )}
              <div>
                {companyLinkedIn || companyWebsite ? (
                  <a
                    href={companyLinkedIn || companyWebsite}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {currentCompanyName || "Company"} ↗
                  </a>
                ) : (
                  <strong>{currentCompanyName || "Company"}</strong>
                )}
                {companyIndustry && <span>{companyIndustry}</span>}
              </div>
            </div>
            <div className="database-field-grid">
              <ReadableField label="Company size" value={companySize || "—"} />
              <ReadableField
                label="Founded"
                value={display(companySummary.founded_year)}
              />
              <ReadableField
                label="Headquarters"
                value={companyLocation || "—"}
              />
              <LinkField
                label="Website"
                href={companyWebsite}
                text="Visit website ↗"
              />
            </div>
            {Boolean(companySummary.description) && (
              <p className="database-company-description">
                {String(companySummary.description)}
              </p>
            )}
          </div>
        </section>
      )}
      {asList(enrichment.positionGroups).length > 0 && (
        <ExperienceTimeline
          groups={asList(enrichment.positionGroups)}
          currentCompany={company}
        />
      )}
      {education.length > 0 && (
        <section>
          <h3>Education</h3>
          <ReadableList title="Education history" items={education} />
        </section>
      )}
      {onDelete && (
        <section className="database-danger-zone">
          <h3>Danger zone</h3>
          <p>Permanently delete this lead and all their conversations and messages. This action cannot be undone.</p>
          <button className="database-delete-lead-button" onClick={onDelete}>Delete lead</button>
        </section>
      )}
    </div>
  );
}

function RetryEnrichmentButton({ leadId }: { leadId: string }) {
  const [enriching, setEnriching] = useState(false);
  const [result, setResult] = useState("");
  const retry = async () => {
    if (enriching) return;
    setEnriching(true);
    setResult("");
    const response = await fetch("/api/ai/enrich", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leadId }) }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    setEnriching(false);
    setResult(response?.ok ? "Enriched successfully — reload to see updates." : String(payload?.error ?? "Enrichment failed."));
    if (response?.ok) setTimeout(() => setResult(""), 5000);
  };
  return (
    <section>
      <h3>Enrichment</h3>
      <p style={{ margin: "0 0 12px", color: "var(--muted)", fontSize: 11 }}>This lead has not been enriched yet. Click below to pull their LinkedIn profile data.</p>
      <button className="retry-enrich-button" onClick={retry} disabled={enriching}>{enriching ? "Enriching…" : "Retry enrichment"}</button>
      {result && <p style={{ marginTop: 8, fontSize: 10, color: result.includes("success") ? "var(--green)" : "var(--coral)" }}>{result}</p>}
    </section>
  );
}

function ReadableField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong className="database-field-label">{label}</strong>
      <span className="database-field-value">{value}</span>
    </div>
  );
}
function LinkField({
  label,
  href,
  text: linkText,
}: {
  label: string;
  href: string;
  text: string;
}) {
  return (
    <div>
      <strong className="database-field-label">{label}</strong>
      {href ? (
        <a
          className="database-field-value"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {linkText}
        </a>
      ) : (
        <span className="database-field-value">—</span>
      )}
    </div>
  );
}
function ReadableTags({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="database-readable-group">
      <small>{title}</small>
      <div className="database-tag-list">
        {items.map((item) => (
          <span key={item}>{humanize(item)}</span>
        ))}
      </div>
    </div>
  );
}
function ReadableList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="database-readable-group">
      <small>{title}</small>
      <ul>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
function recordLabels(value: unknown, keys: string[]) {
  return asList(value)
    .map((item) => {
      const row = asObject(item);
      return uniqueText(
        keys.map((key) => {
          const candidate = row[key];
          return typeof candidate === "object"
            ? text(asObject(candidate).name || asObject(candidate).title)
            : candidate;
        }),
      ).join(" · ");
    })
    .filter(Boolean);
}

function ExperienceTimeline({
  groups,
  currentCompany,
}: {
  groups: unknown[];
  currentCompany: Record<string, unknown>;
}) {
  const currentSummary = asObject(currentCompany.summary);
  const currentLinks = asObject(currentCompany.link);
  const currentName = text(
    currentSummary.name || currentCompany.name,
  ).toLowerCase();
  return (
    <section>
      <h3>Experience</h3>
      <div className="database-experience-list">
        {groups.map((item, index) => {
          const group = asObject(item);
          const company = asObject(group.company);
          const companyName =
            text(company.name || group.company_name) || "Unknown company";
          const groupDate = asObject(group.date);
          const roles = asList(
            group.profile_positions || group.positions || group.position,
          ).map(asObject);
          const isCurrentCompany = Boolean(
            currentName && companyName.toLowerCase() === currentName,
          );
          const linkedIn = externalUrl(company.url);
          const website = isCurrentCompany
            ? externalUrl(currentLinks.website)
            : "";
          const destination = linkedIn || website;
          const industry = isCurrentCompany
            ? text(currentSummary.industry || currentCompany.industry)
            : "";
          return (
            <article key={`${companyName}-${index}`}>
              <header>
                {Boolean(company.logo) && (
                  <img src={String(company.logo)} alt="" />
                )}
                <div>
                  <strong>{companyName}</strong>
                  {industry && <span>{industry}</span>}
                </div>
                {destination && (
                  <a
                    className="database-company-link"
                    href={destination}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View company ↗
                  </a>
                )}
              </header>
              {roles.length ? (
                roles.map((role, roleIndex) => {
                  const dates = asObject(role.date);
                  const start = dates.start || groupDate.start;
                  const end = dates.end || groupDate.end;
                  return (
                    <div
                      className="database-role"
                      key={`${text(role.title)}-${roleIndex}`}
                    >
                      <h4>{display(role.title || role.name)}</h4>
                      <p className="database-role-dates">
                        {monthYear(start)} – {monthYear(end)}
                        {start ? ` · ${durationBetween(start, end)}` : ""}
                      </p>
                    </div>
                  );
                })
              ) : (
                <div className="database-role">
                  <p className="database-role-dates">
                    {monthYear(groupDate.start)} – {monthYear(groupDate.end)}
                    {groupDate.start
                      ? ` · ${durationBetween(groupDate.start, groupDate.end)}`
                      : ""}
                  </p>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function LeadActivity({
  detail,
  onLoadOlder,
}: {
  detail: Detail;
  onLoadOlder: () => void;
}) {
  const leadRaw =
    detail.lead.raw_data && typeof detail.lead.raw_data === "object"
      ? detail.lead.raw_data
      : {};
  const enrichment = asObject(asObject(asObject(leadRaw).reply_radar).ai_ark);
  const leadName = display(detail.lead.name);
  const leadPhoto = text(enrichment.profilePhotoSource || enrichment.profilePhotoUrl);
  const clientById = new Map(
    (detail.workspaces ?? []).map((workspace) => [
      String(workspace.id),
      String(workspace.name),
    ]),
  );
  return (
    <div className="database-activity">
      {detail.conversations.map((conversation) => {
        const conversationMessages = detail.messages
          .filter((message) => message.conversation_id === conversation.id)
          .sort(
            (a, b) =>
              new Date(String(a.sent_at)).getTime() -
              new Date(String(b.sent_at)).getTime(),
          );
        const sender = senderNameFrom(
          ...conversationMessages.map((message) => message.raw_data),
          leadRaw,
        );
        const campaign = campaignNameFrom(
          ...conversationMessages.map((message) => message.raw_data),
          leadRaw,
        );
        const latestInboundId = [...conversationMessages]
          .reverse()
          .find((message) => message.direction === "inbound")?.id;
        return (
          <section
            className="database-conversation-history"
            key={String(conversation.id)}
          >
            <header>
              <h3>{campaign}</h3>
              <small>
                {clientById.get(String(conversation.workspace_id)) || "Client"}{" "}
                · {sender} · {when(conversation.last_message_at)}
              </small>
            </header>
            <div className="database-activity-thread">
              {conversationMessages.map((message) => {
                const inbound = message.direction === "inbound";
                return (
                  <div
                    className={`bubble ${inbound ? "inbound" : "outbound"} ${message.id === latestInboundId ? "latest-inbound" : ""}`}
                    key={String(message.id)}
                  >
                    {inbound && (
                      <span>
                        {leadPhoto ? (
                          <img src={leadPhoto} alt="" />
                        ) : (
                          initials(leadName)
                        )}
                      </span>
                    )}
                    <small className="message-author">
                      {inbound
                        ? leadName
                        : senderNameFrom(message.raw_data, leadRaw)}
                    </small>
                    <p>{display(message.body)}</p>
                    <time>{when(message.sent_at)}</time>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {detail.conversations.length === 0 && (
        <p className="empty-state">
          No conversation history is stored for this lead yet.
        </p>
      )}
      {detail.hasMoreMessages && (
        <button className="database-load-more" onClick={onLoadOlder}>
          Load older history
        </button>
      )}
    </div>
  );
}
function DatabaseSkeleton() {
  return (
    <div className="database-skeleton" aria-label="Loading database">
      <i />
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}
