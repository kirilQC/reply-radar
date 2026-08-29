// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import "../../cold-calling.css";

type CallLead = {
  id: string; name: string; title: string | null; company: string | null; linkedin: string | null;
  phone: string | null; photoUrl: string | null; companyLogoUrl: string | null;
  icpScore: number | null; icpReason: string | null; replied: boolean;
  campaign: string | null; activity: string; lastCall: { caller: string | null; result: string | null; notes: string | null; at: string } | null; callCount: number;
};
type Client = { name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type Campaign = { id: string; name: string; status: string; listSize: number; fetched: number; enriched: number; job: { status: string; leadsFetched: number; leadsEnriched: number; total: number; error: string | null } | null };
type Detail = { lead: Record<string, unknown>; conversations?: unknown[]; messages?: unknown[]; workspaces?: unknown[] };

const RESULTS = ["Connected", "Voicemail", "No answer", "Interested", "Callback", "Not interested", "Bad number", "Do not call"];
const scoreClass = (s: number | null) => (s == null ? "none" : s >= 70 ? "hot" : s >= 40 ? "warm" : "cool");
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, "")}`;
const pct = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0);
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();

// ── tiny helpers for reading the stored lead record ──
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const nameOf = (v: unknown): string => (typeof v === "string" ? v.trim() : v && typeof v === "object" ? str(obj(v).name).trim() : "");
const nested = (o: unknown, k: string) => obj(obj(o)[k]);
const humanize = (s: unknown) => str(s).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const locationText = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  const o = obj(v);
  return [o.city, o.state, o.country].map(str).filter(Boolean).join(", ") || str(o.name) || str(o.default) || "";
};
const externalUrl = (v: unknown): string => {
  const raw = typeof v === "object" && v ? str(obj(v).url || obj(v).website || obj(v).linkedin) : str(v);
  const s = raw.trim();
  if (!s || s === "null") return "";
  return s.startsWith("http") ? s : `https://${s}`;
};
const whenDate = (v: unknown): string => {
  const s = str(v); if (!s) return "";
  const d = new Date(s); return Number.isNaN(+d) ? s : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

/** An image that falls back to its `fallback` node if the src is missing or fails to load (broken photos). */
function SmartImg({ src, className, fallback }: { src: string | null; className: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <>{fallback}</>;
  return <img className={className} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function QueueAvatar({ lead }: { lead: CallLead }) {
  return (
    <span className="cc-avatar cc-avatar-sm">
      <SmartImg src={lead.photoUrl} className="cc-avatar-photo" fallback={<span className="cc-avatar-mono">{initials(lead.name)}</span>} />
      {lead.companyLogoUrl
        ? <SmartImg src={lead.companyLogoUrl} className="cc-avatar-co" fallback={lead.company ? <span className="cc-avatar-co cc-avatar-co-mono">{initials(lead.company)}</span> : <></>} />
        : lead.company ? <span className="cc-avatar-co cc-avatar-co-mono">{initials(lead.company)}</span> : null}
    </span>
  );
}

export default function ClientCallList() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<Client | null>(null);
  const [leads, setLeads] = useState<CallLead[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [campaignsOpen, setCampaignsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const response = await fetch(`/api/cold-calling/${encodeURIComponent(slug)}`, { cache: "no-store" });
      if (response.status === 404) { setNotFound(true); setLoading(false); return; }
      const payload = await response.json().catch(() => ({}));
      if (payload.ok) {
        setClient(payload.client);
        setLeads(Array.isArray(payload.leads) ? payload.leads : []);
        setCampaigns(Array.isArray(payload.campaigns) ? payload.campaigns : []);
      }
    } catch { /* keep previous */ }
    setLoading(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (slug) void load(); }, [slug]);

  const anyJobActive = campaigns.some((c) => c.job && c.job.status !== "done" && c.job.status !== "error");
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (anyJobActive) { setCampaignsOpen(true); pollRef.current = setInterval(() => void load(), 6000); }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyJobActive, slug]);

  // The call list only shows people we can actually dial — a number is implied.
  const queue = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads.filter((l) => l.phone && (!q || `${l.name} ${l.company ?? ""} ${l.title ?? ""}`.toLowerCase().includes(q)));
  }, [leads, query]);

  useEffect(() => {
    if (queue.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !queue.some((l) => l.id === selectedId)) setSelectedId(queue[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  const current = queue.find((l) => l.id === selectedId) ?? null;

  // Pull the full lead record (same source the lead database uses) whenever the selection changes.
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true); setDetail(null);
    void (async () => {
      try {
        const r = await fetch(`/api/database/leads/${encodeURIComponent(selectedId)}`, { cache: "no-store" });
        const p = await r.json().catch(() => ({}));
        if (!cancelled) setDetail(p && p.lead ? p : (p?.detail ?? p));
      } catch { if (!cancelled) setDetail(null); }
      if (!cancelled) setDetailLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  const advance = () => {
    const idx = queue.findIndex((l) => l.id === selectedId);
    const next = queue[idx + 1];
    setSelectedId(next ? next.id : selectedId);
  };

  const fetchCampaign = async (c: Campaign) => {
    setBusy(true);
    await fetch("/api/cold-calling/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, campaignId: c.id, campaignName: c.name }) }).catch(() => {});
    setBusy(false); await load();
  };

  const saveAndNext = async (leadId: string, result: string, notes: string, goNext: boolean) => {
    setBusy(true);
    await fetch("/api/cold-calling/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leadId, result, notes }) }).catch(() => {});
    if (goNext) advance();
    setBusy(false);
    await load();
  };

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Cold calling", href: "/cold-calling" }, { label: client?.name || "Client" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="cc-shell cc-cockpit">
          {loading && <p className="cc-muted">Loading call list…</p>}
          {notFound && !loading && <div className="cc-empty">That client was not found. <Link href="/cold-calling" style={{ color: "var(--accent)" }}>Back</Link>.</div>}

          {client && (
            <>
              <Link href="/cold-calling" className="cc-back">← All clients</Link>
              <div className="cc-client-head">
                <div className="cc-client-brand">
                  <span className="cc-client-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
                    {client.logoUrl ? <img src={client.logoUrl} alt="" /> : initials(client.name)}
                  </span>
                  <div className="cc-client-titles">
                    <h1>{client.name}</h1>
                    <p>{queue.length} to call · sorted by ICP score</p>
                  </div>
                </div>
                <a className="cc-export" href={`/api/cold-calling/export?slug=${encodeURIComponent(slug)}`}>Export CSV</a>
              </div>

              {/* Campaigns — pull the non-repliers, with a live progress bar */}
              <div className="cc-campaigns">
                <button type="button" className={`cc-campaigns-head ${campaignsOpen ? "open" : ""}`} onClick={() => setCampaignsOpen((v) => !v)}>
                  <span className="cc-caret" aria-hidden>▸</span>
                  <span>Pull leads from a campaign</span>
                  <span className="cc-muted">{anyJobActive ? "working…" : `${campaigns.length} campaigns`}</span>
                </button>
                {campaignsOpen && (
                  <div className="cc-campaign-list">
                    {campaigns.length === 0 && <p className="cc-muted" style={{ padding: "6px 2px" }}>No campaigns found for this client.</p>}
                    {campaigns.map((c) => {
                      const running = c.job && c.job.status !== "done" && c.job.status !== "error";
                      const phase = c.job?.status === "enriching" ? "enrich" : c.job?.status === "fetching" ? "fetch" : "queue";
                      const barPct = phase === "enrich" ? pct(c.job!.leadsEnriched, c.job!.leadsFetched || c.listSize) : phase === "fetch" ? pct(c.job!.leadsFetched, c.job!.total || c.listSize) : 4;
                      return (
                        <div className={`cc-campaign ${running ? "running" : ""}`} key={c.id}>
                          <div className="cc-campaign-main">
                            <strong>{c.name}</strong>
                            <span className="cc-muted">{c.listSize} leads · {c.fetched} fetched · {c.enriched} enriched{c.status ? ` · ${c.status.toLowerCase()}` : ""}</span>
                            {running && (
                              <div className="cc-progress">
                                <span className="cc-progress-bar"><i style={{ width: `${barPct}%` }} className={phase} /></span>
                                <span className="cc-progress-label">{phase === "queue" ? "Queued…" : phase === "fetch" ? `Fetching ${c.job!.leadsFetched}/${c.job!.total || c.listSize}` : `Enriching ${c.job!.leadsEnriched}/${c.job!.leadsFetched}`}</span>
                              </div>
                            )}
                            {!running && c.job?.error && <div className="cc-campaign-error">⚠ {c.job.error}</div>}
                          </div>
                          {!running && <button type="button" className="cc-fetch" disabled={busy} onClick={() => void fetchCampaign(c)}>{c.fetched > 0 ? "Refresh & enrich" : "Fetch & enrich"}</button>}
                        </div>
                      );
                    })}
                    <p className="cc-note">Fetching pulls everyone in the campaign and reveals a mobile number for each (uses AI Ark credits). It runs in the background — leads appear as they finish.</p>
                  </div>
                )}
              </div>

              {queue.length === 0 ? (
                <div className="cc-empty">No leads with a number yet. Open “Pull leads from a campaign” above to build your list.</div>
              ) : (
                <div className="cc-cockpit-grid">
                  <section className="cc-current">
                    {current
                      ? <CurrentLead lead={current} detail={detail} detailLoading={detailLoading} busy={busy} onSave={(r, n, next) => void saveAndNext(current.id, r, n, next)} onSkip={advance} />
                      : <div className="cc-empty">No leads match your filter.</div>}
                  </section>

                  <aside className="cc-queue">
                    <div className="cc-queue-head">
                      <input className="cc-search" value={query} placeholder="Search name or company…" onChange={(e) => setQuery(e.target.value)} />
                    </div>
                    <div className="cc-queue-count">{queue.length} in queue · by ICP score</div>
                    <div className="cc-queue-list">
                      {queue.map((l) => (
                        <button type="button" key={l.id} className={`cc-queue-item ${l.id === selectedId ? "is-current" : ""} ${l.callCount > 0 ? "is-done" : ""}`} onClick={() => setSelectedId(l.id)}>
                          <QueueAvatar lead={l} />
                          <span className="cc-qwho"><b>{l.name}</b><em>{l.company || l.title || "—"}</em></span>
                          {l.callCount > 0 ? <span className="cc-qtick">✓</span> : <span className={`cc-qscore ${scoreClass(l.icpScore)}`}>{l.icpScore ?? "—"}</span>}
                        </button>
                      ))}
                    </div>
                  </aside>
                </div>
              )}
            </>
          )}
        </main>
      </section>
    </div>
  );
}

function CurrentLead({ lead, detail, detailLoading, busy, onSave, onSkip }: { lead: CallLead; detail: Detail | null; detailLoading: boolean; busy: boolean; onSave: (result: string, notes: string, next: boolean) => void; onSkip: () => void }) {
  const [result, setResult] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => { setResult(""); setNotes(""); }, [lead.id]);

  return (
    <div className="cc-current-inner">
      {/* Hero — who you're calling */}
      <div className="cc-current-top">
        <span className={`cc-hero-avatar ring-${scoreClass(lead.icpScore)}`}>
          <SmartImg src={lead.photoUrl} className="cc-hero-photo" fallback={<span className="cc-hero-mono">{initials(lead.name)}</span>} />
          <span className={`cc-hero-icp ${scoreClass(lead.icpScore)}`}>{lead.icpScore ?? "—"}</span>
        </span>
        <div className="cc-current-id">
          <h2>{lead.name}{lead.linkedin && <a className="cc-li" href={lead.linkedin} target="_blank" rel="noreferrer">in</a>}</h2>
          <p className="cc-current-role">
            {lead.companyLogoUrl
              ? <SmartImg src={lead.companyLogoUrl} className="cc-role-logo" fallback={lead.company ? <span className="cc-role-logo cc-role-logo-mono">{initials(lead.company)}</span> : <></>} />
              : lead.company ? <span className="cc-role-logo cc-role-logo-mono">{initials(lead.company)}</span> : null}
            <span>{[lead.title, lead.company].filter(Boolean).join(" · ") || "Role and company not recorded"}</span>
          </p>
          <div className="cc-current-meta">
            <span className={`cc-activity ${lead.replied ? "replied" : ""}`}>{lead.activity}</span>
            {lead.campaign && <span className="cc-chip">{lead.campaign}</span>}
            {lead.callCount > 0 && <span className="cc-chip done">{lead.callCount} call{lead.callCount === 1 ? "" : "s"} logged</span>}
          </div>
        </div>
      </div>

      {/* Dial + log — the action */}
      <div className="cc-action">
        {lead.phone
          ? <a className="cc-phone-lg" href={telHref(lead.phone)}>☎ {lead.phone}</a>
          : <span className="cc-nophone-lg">No phone number for this lead</span>}
        <div className="cc-logblock">
          <div className="cc-log-label">Log the result</div>
          <div className="cc-results">
            {RESULTS.map((r) => (
              <button type="button" key={r} className={`cc-result ${result === r ? "is-on" : ""}`} onClick={() => setResult((cur) => (cur === r ? "" : r))}>{r}</button>
            ))}
          </div>
          <textarea value={notes} placeholder="What happened on the call…" rows={2} onChange={(e) => setNotes(e.target.value)} />
          <div className="cc-log-actions">
            <button type="button" className="cc-skip" onClick={onSkip}>Skip →</button>
            <button type="button" className="cc-savenext" disabled={busy || (!result && !notes.trim())} onClick={() => onSave(result, notes, true)}>{busy ? "Saving…" : "Save & next →"}</button>
          </div>
        </div>
      </div>

      {lead.lastCall && (
        <div className="cc-lastcall">Last call: <b>{lead.lastCall.result || "logged"}</b>{lead.lastCall.caller ? ` by ${lead.lastCall.caller}` : ""}{lead.lastCall.notes ? ` — “${lead.lastCall.notes}”` : ""}</div>
      )}

      {/* Full lead record */}
      <LeadRecord lead={lead} detail={detail} loading={detailLoading} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  const empty = value == null || value === "" || value === "—";
  return (
    <div className="cc-field">
      <b>{label}</b>
      <span className={empty ? "is-empty" : undefined}>{empty ? "—" : value}</span>
    </div>
  );
}
function ExtLink({ href, text }: { href: string; text: string }) {
  return href ? <a href={href} target="_blank" rel="noreferrer">{text}</a> : <span className="is-empty">—</span>;
}

/** The lead's full record, derived from the same stored payload the lead database renders from. */
function LeadRecord({ lead, detail, loading }: { lead: CallLead; detail: Detail | null; loading: boolean }) {
  const raw = obj(detail?.lead?.raw_data);
  const rr = nested(raw, "reply_radar");
  const e = nested(rr, "ai_ark");
  const rollup = nested(rr, "rollup");
  const company = obj(e.company);
  const summary = obj(company.summary);
  const links = obj(company.link);
  const dept = obj(e.department);
  const stats = obj(e.statistics); const net = obj(stats.network);
  const staff = obj(summary.staff); const range = obj(staff.range);

  const email = str(raw.email_address || raw.custom_email || raw.enriched_email);
  const location = locationText(raw.location || e.location);
  const departmentLabels = [dept.seniority, ...arr(dept.functions), ...arr(dept.departments), ...arr(dept.sub_departments)]
    .map(humanize).filter(Boolean);
  const network = [
    net.followers_count ? `${Number(net.followers_count).toLocaleString()} followers` : "",
    net.connections_count ? `${Number(net.connections_count).toLocaleString()} connections` : "",
  ].filter(Boolean).join(" · ");
  const education = arr(e.educations).map((it) => nameOf(obj(it).school_name || obj(it).school || obj(it).name)).filter(Boolean);
  const companyName = nameOf(summary.name || company.name) || str(lead.company);
  const companyIndustry = str(summary.industry || company.industry || e.industry);
  const companySize = range.start || range.end
    ? `${str(range.start || "?")}–${str(range.end || "?")} employees`
    : staff.total ? `${Number(staff.total).toLocaleString()} employees` : "";
  const companyLocation = locationText(obj(company.location).headquarter);
  const clients = (Array.isArray(rollup.clients) ? rollup.clients.map(String) : (detail?.workspaces ?? []).map((w) => str(obj(w).name))).filter(Boolean);
  const campaigns = (Array.isArray(rollup.campaigns) ? rollup.campaigns.map(String) : []).filter(Boolean);
  const senders = (Array.isArray(rollup.senders) ? rollup.senders.map(String) : []).filter(Boolean);
  const headline = str(e.headline || raw.summary);
  const hasEnrichment = Object.keys(e).length > 0;

  if (loading && !detail) return <div className="cc-record"><div className="cc-record-loading">Loading full record…</div></div>;

  return (
    <div className="cc-record">
      {lead.icpReason && (
        <section className="cc-rsection cc-rspan">
          <h4>Why this ICP score</h4>
          <p className="cc-reason-text">{lead.icpReason}</p>
        </section>
      )}
      {headline && (
        <section className="cc-rsection cc-rspan">
          <h4>Headline</h4>
          <p className="cc-reason-text">{headline}</p>
        </section>
      )}

      <section className="cc-rsection">
        <h4>Contact</h4>
        <div className="cc-field-grid">
          <Field label="Phone" value={lead.phone ? <a href={telHref(lead.phone)}>{lead.phone}</a> : "—"} />
          <Field label="Email" value={email} />
          <Field label="Location" value={location} />
          <Field label="LinkedIn" value={<ExtLink href={externalUrl(lead.linkedin || raw.linkedin_profile_url)} text="Open profile ↗" />} />
        </div>
      </section>

      {hasEnrichment && (
        <section className="cc-rsection">
          <h4>Professional</h4>
          <div className="cc-field-grid">
            <Field label="Current role" value={lead.title || str(e.title)} />
            <Field label="Seniority & department" value={departmentLabels.join(" · ")} />
            <Field label="Network" value={network} />
            <Field label="Education" value={education.slice(0, 2).join(" · ")} />
          </div>
        </section>
      )}

      <section className="cc-rsection">
        <h4>Company</h4>
        <div className="cc-field-grid">
          <Field label="Company" value={companyName} />
          <Field label="Industry" value={companyIndustry} />
          <Field label="Size" value={companySize} />
          <Field label="HQ" value={companyLocation} />
          <Field label="Website" value={<ExtLink href={externalUrl(links.website || raw.company_url)} text="Open website ↗" />} />
          <Field label="Company LinkedIn" value={<ExtLink href={externalUrl(links.linkedin)} text="Open on LinkedIn ↗" />} />
        </div>
      </section>

      {(clients.length > 0 || campaigns.length > 0 || senders.length > 0) && (
        <section className="cc-rsection cc-rspan">
          <h4>Outreach</h4>
          <div className="cc-field-grid">
            <Field label="Clients" value={clients.join(", ")} />
            <Field label="Campaigns" value={campaigns.join(", ")} />
            <Field label="Senders" value={senders.join(", ")} />
            <Field label="First stored" value={whenDate(detail?.lead?.created_at)} />
          </div>
        </section>
      )}
    </div>
  );
}
