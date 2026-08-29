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
  icpScore: number | null; icpReason: string | null; replied: boolean; status: "replied" | "no_reply";
  campaign: string | null; campaigns: string[]; senders: string[]; lastReplyAt: string | null;
  activity: string; lastCall: { caller: string | null; result: string | null; notes: string | null; at: string } | null; callCount: number;
};
type Msg = { direction?: string; body?: string; sent_at?: string; conversation_id?: string };
type Client = { name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type Campaign = { id: string; name: string; status: string; listSize: number; fetched: number; enriched: number; job: { status: string; leadsFetched: number; leadsEnriched: number; total: number; error: string | null } | null };
type Detail = { lead: Record<string, unknown>; conversations?: Record<string, unknown>[]; messages?: Msg[]; workspaces?: unknown[] };
type SortBy = "icp" | "newest" | "oldest";
type Seg = "all" | "replied" | "no_reply" | "called";

const RESULTS = ["Connected", "Voicemail", "No answer", "Interested", "Callback", "Not interested", "Bad number", "Do not call"];
const scoreClass = (s: number | null) => (s == null ? "none" : s >= 70 ? "hot" : s >= 40 ? "warm" : "cool");
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, "")}`;
const pct = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0);
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();
const relTime = (v: string | null) => {
  if (!v) return "";
  const d = new Date(v); if (Number.isNaN(+d)) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

// ── helpers for reading the stored lead record ──
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

/** An image that falls back to `fallback` if the src is missing or fails (broken/expired photos). */
function SmartImg({ src, className, fallback }: { src: string | null; className: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <>{fallback}</>;
  return <img className={className} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** Round photo with the company logo tucked into the corner. */
function Avatar({ lead, size }: { lead: CallLead; size: number }) {
  return (
    <span className="cc-av" style={{ width: size, height: size }}>
      <SmartImg src={lead.photoUrl} className="cc-av-photo" fallback={<span className="cc-av-mono">{initials(lead.name)}</span>} />
      <span className="cc-av-co">
        <SmartImg src={lead.companyLogoUrl} className="cc-av-co-img" fallback={<span className="cc-av-co-mono">{lead.company ? initials(lead.company) : "·"}</span>} />
      </span>
    </span>
  );
}

const statusOf = (lead: CallLead, messages: Msg[] | null): { label: string; cls: string } => {
  const hasInbound = (messages ?? []).some((m) => (m.direction || "").toLowerCase() === "inbound");
  if (hasInbound || lead.replied) return { label: "Replied", cls: "rep" };
  if ((messages ?? []).length > 0) return { label: "Messaged · no reply", cls: "wait" };
  return { label: "No reply yet", cls: "no" };
};

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
  const [seg, setSeg] = useState<Seg>("all");
  const [sortBy, setSortBy] = useState<SortBy>("icp");
  const [fCampaign, setFCampaign] = useState("");
  const [fSender, setFSender] = useState("");
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

  // Keep draining active jobs from the browser (single-flight) so they finish even without the cron worker —
  // the background function hits Vercel's execution limit on large campaigns and would otherwise stall. Each
  // poke resumes the oldest active job; already-enriched leads (with a phone) are skipped, so no re-charge.
  const drainingRef = useRef(false);
  useEffect(() => {
    if (!anyJobActive) return;
    let stopped = false;
    const drain = async () => {
      if (stopped || drainingRef.current) return;
      drainingRef.current = true;
      try { await fetch("/api/cold-calling/process", { method: "POST" }); } catch { /* ignore */ }
      drainingRef.current = false;
      if (!stopped) await load();
    };
    void drain();
    const id = setInterval(() => void drain(), 8000);
    return () => { stopped = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyJobActive, slug]);

  const campaignOptions = useMemo(() => Array.from(new Set(leads.flatMap((l) => l.campaigns))).sort(), [leads]);
  const senderOptions = useMemo(() => Array.from(new Set(leads.flatMap((l) => l.senders))).sort(), [leads]);
  const repliedCount = useMemo(() => leads.filter((l) => l.phone && l.replied).length, [leads]);

  const queue = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = leads.filter((l) =>
      l.phone
      && (!q || `${l.name} ${l.company ?? ""} ${l.title ?? ""}`.toLowerCase().includes(q))
      && (!fCampaign || l.campaigns.includes(fCampaign))
      && (!fSender || l.senders.includes(fSender))
      && (seg === "all" || (seg === "replied" && l.replied) || (seg === "no_reply" && !l.replied) || (seg === "called" && l.callCount > 0)));
    const time = (l: CallLead) => (l.lastReplyAt ? new Date(l.lastReplyAt).getTime() : 0);
    const sorted = [...filtered];
    if (sortBy === "newest") sorted.sort((a, b) => time(b) - time(a));
    else if (sortBy === "oldest") sorted.sort((a, b) => (time(a) || Infinity) - (time(b) || Infinity));
    else sorted.sort((a, b) => (b.icpScore ?? -1) - (a.icpScore ?? -1));
    return sorted;
  }, [leads, query, fCampaign, fSender, seg, sortBy]);

  useEffect(() => {
    if (queue.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !queue.some((l) => l.id === selectedId)) setSelectedId(queue[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  const current = queue.find((l) => l.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true); setDetail(null);
    void (async () => {
      try {
        const r = await fetch(`/api/database/leads/${encodeURIComponent(selectedId)}`, { cache: "no-store" });
        const p = await r.json().catch(() => ({}));
        if (!cancelled) setDetail(p && p.lead ? p : null);
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
  const saveAndNext = async (leadId: string, result: string, notes: string) => {
    setBusy(true);
    await fetch("/api/cold-calling/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leadId, result, notes }) }).catch(() => {});
    advance();
    setBusy(false);
    await load();
  };

  const segs: [Seg, string][] = [["all", "All"], ["replied", "Replied"], ["no_reply", "No reply"], ["called", "Called"]];

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Cold calling", href: "/cold-calling" }, { label: client?.name || "Client" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="cc-shell cc-inbox-shell">
          {loading && <p className="cc-muted">Loading call list…</p>}
          {notFound && !loading && <div className="cc-empty">That client was not found. <Link href="/cold-calling" style={{ color: "var(--accent)" }}>Back</Link>.</div>}

          {client && (
            <>
              <div className="cc-client-head">
                <div className="cc-client-brand">
                  <span className="cc-client-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
                    {client.logoUrl ? <img src={client.logoUrl} alt="" /> : initials(client.name)}
                  </span>
                  <div className="cc-client-titles"><h1>{client.name}</h1></div>
                </div>
                <div className="cc-head-tools">
                  <select className="cc-select" value={fCampaign} onChange={(e) => setFCampaign(e.target.value)}>
                    <option value="">All campaigns</option>
                    {campaignOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select className="cc-select" value={fSender} onChange={(e) => setFSender(e.target.value)}>
                    <option value="">All senders</option>
                    {senderOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className="cc-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                    <option value="icp">Sort · ICP</option>
                    <option value="newest">Sort · Newest reply</option>
                    <option value="oldest">Sort · Oldest reply</option>
                  </select>
                  <a className="cc-export" href={`/api/cold-calling/export?slug=${encodeURIComponent(slug)}`}>Export</a>
                </div>
              </div>

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

              {!leads.some((l) => l.phone) ? (
                <div className="cc-empty">No leads with a number yet. Open “Pull leads from a campaign” above to build your list.</div>
              ) : (
                <div className="cc-inbox">
                  {/* Left — the list */}
                  <div className="cc-list">
                    <div className="cc-list-top">
                      <input className="cc-search" value={query} placeholder="Search name or company…" onChange={(e) => setQuery(e.target.value)} />
                      <div className="cc-segs">
                        {segs.map(([v, label]) => (
                          <button type="button" key={v} className={`cc-seg ${seg === v ? "on" : ""}`} onClick={() => setSeg(v)}>{label}{v === "replied" ? ` · ${repliedCount}` : ""}</button>
                        ))}
                      </div>
                    </div>
                    <div className="cc-list-rows">
                      {queue.length === 0 && <p className="cc-muted" style={{ padding: "18px 16px" }}>No leads match.</p>}
                      {queue.map((l) => (
                        <button type="button" key={l.id} className={`cc-lrow ${l.id === selectedId ? "on" : ""}`} onClick={() => setSelectedId(l.id)}>
                          <Avatar lead={l} size={42} />
                          <span className="cc-lrow-body">
                            <span className="cc-lrow-top"><b>{l.name}</b>{l.lastReplyAt && <time>{relTime(l.lastReplyAt)}</time>}</span>
                            <span className="cc-lrow-sub">{[l.title, l.company].filter(Boolean).join(" · ") || "—"}</span>
                            <span className="cc-lrow-tags">
                              <span className={`cc-pill ${l.replied ? "rep" : "no"}`}><span className="cc-pill-dot" />{l.replied ? "Replied" : "No reply"}</span>
                              {l.callCount > 0 && <span className="cc-pill called"><span className="cc-pill-dot" />Called</span>}
                              <span className={`cc-icp ${scoreClass(l.icpScore)}`}>{l.icpScore ?? "—"}</span>
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Right — the conversation + record + call */}
                  <div className="cc-convo">
                    {current
                      ? <LeadPane lead={current} detail={detail} detailLoading={detailLoading} busy={busy} onSave={(r, n) => void saveAndNext(current.id, r, n)} onSkip={advance} />
                      : <div className="cc-empty" style={{ margin: 24 }}>Pick a lead from the list.</div>}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </section>
    </div>
  );
}

function LeadPane({ lead, detail, detailLoading, busy, onSave, onSkip }: { lead: CallLead; detail: Detail | null; detailLoading: boolean; busy: boolean; onSave: (result: string, notes: string) => void; onSkip: () => void }) {
  const [result, setResult] = useState("");
  const [notes, setNotes] = useState("");
  const [showRecord, setShowRecord] = useState(false);
  useEffect(() => { setResult(""); setNotes(""); setShowRecord(false); }, [lead.id]);

  const messages = detail?.messages ?? null;
  const status = statusOf(lead, messages);

  return (
    <div className="cc-lp">
      {/* Header */}
      <div className="cc-lp-head">
        <Avatar lead={lead} size={52} />
        <div className="cc-lp-id">
          <div className="cc-lp-name">{lead.name}{lead.linkedin && <a className="cc-li" href={lead.linkedin} target="_blank" rel="noreferrer">in</a>}<span className={`cc-pill ${status.cls}`}><span className="cc-pill-dot" />{status.label}</span></div>
          <div className="cc-lp-role">{[lead.title, lead.company].filter(Boolean).join(" · ") || "Role and company not recorded"}{lead.senders.length > 0 && <span className="cc-lp-via"> · via {lead.senders.join(", ")}</span>}</div>
        </div>
        {lead.phone
          ? <a className="cc-callbtn" href={telHref(lead.phone)}><svg className="cc-phone-ic" viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 5.2 2 2 0 0 1 4 3h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 12a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 17z"/></svg>{lead.phone}</a>
          : <span className="cc-nophone">No number</span>}
      </div>

      {/* Scroll: conversation + record */}
      <div className="cc-lp-scroll">
        {detailLoading && !detail
          ? <p className="cc-muted" style={{ padding: "24px 22px" }}>Loading conversation…</p>
          : messages && messages.length > 0
            ? <Conversation messages={messages} />
            : <div className="cc-thread-empty-wrap"><p className="cc-thread-empty">No LinkedIn messages on record — this lead hasn’t replied. Give them a call.</p></div>}

        {lead.icpReason && (
          <div className="cc-why"><span className="cc-why-label">Why ICP {lead.icpScore ?? ""}</span>{lead.icpReason}</div>
        )}

        <button type="button" className="cc-record-toggle" onClick={() => setShowRecord((v) => !v)}>
          <span className="cc-caret" style={{ transform: showRecord ? "rotate(90deg)" : undefined }} aria-hidden>▸</span>
          {showRecord ? "Hide full lead record" : "Show full lead record"}
        </button>
        {showRecord && <LeadRecord lead={lead} detail={detail} loading={detailLoading} />}
      </div>

      {/* Log bar */}
      <div className="cc-lp-log">
        {lead.lastCall && <div className="cc-lastcall">Last: <b>{lead.lastCall.result || "logged"}</b>{lead.lastCall.notes ? ` — “${lead.lastCall.notes}”` : ""}</div>}
        <div className="cc-results">
          {RESULTS.map((r) => (
            <button type="button" key={r} className={`cc-result ${result === r ? "is-on" : ""}`} onClick={() => setResult((cur) => (cur === r ? "" : r))}>{r}</button>
          ))}
        </div>
        <div className="cc-log-row">
          <input className="cc-log-note" value={notes} placeholder="Add a note…" onChange={(e) => setNotes(e.target.value)} />
          <button type="button" className="cc-skip" onClick={onSkip}>Skip</button>
          <button type="button" className="cc-savenext" disabled={busy || (!result && !notes.trim())} onClick={() => onSave(result, notes)}>{busy ? "Saving…" : "Save & next →"}</button>
        </div>
      </div>
    </div>
  );
}

function msgTime(v: unknown): string {
  const s = str(v); if (!s) return "";
  const d = new Date(s); if (Number.isNaN(+d)) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function Conversation({ messages }: { messages: Msg[] }) {
  const sorted = [...messages].sort((a, b) => new Date(str(a.sent_at) || 0).getTime() - new Date(str(b.sent_at) || 0).getTime());
  return (
    <div className="cc-thread">
      {sorted.map((m, i) => {
        const inbound = (m.direction || "").toLowerCase() === "inbound";
        return (
          <div className={`cc-msg ${inbound ? "in" : "out"}`} key={i}>
            <div className="cc-bubble">{str(m.body) || "—"}</div>
            <time>{msgTime(m.sent_at)}</time>
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  const empty = value == null || value === "" || value === "—";
  return <div className="cc-field"><b>{label}</b><span className={empty ? "is-empty" : undefined}>{empty ? "—" : value}</span></div>;
}
function ExtLink({ href, text }: { href: string; text: string }) {
  return href ? <a href={href} target="_blank" rel="noreferrer">{text}</a> : <span className="is-empty">—</span>;
}

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
  const departmentLabels = [dept.seniority, ...arr(dept.functions), ...arr(dept.departments), ...arr(dept.sub_departments)].map(humanize).filter(Boolean);
  const network = [net.followers_count ? `${Number(net.followers_count).toLocaleString()} followers` : "", net.connections_count ? `${Number(net.connections_count).toLocaleString()} connections` : ""].filter(Boolean).join(" · ");
  const education = arr(e.educations).map((it) => nameOf(obj(it).school_name || obj(it).school || obj(it).name)).filter(Boolean);
  const companyName = nameOf(summary.name || company.name) || str(lead.company);
  const companyIndustry = str(summary.industry || company.industry || e.industry);
  const companySize = range.start || range.end ? `${str(range.start || "?")}–${str(range.end || "?")} employees` : staff.total ? `${Number(staff.total).toLocaleString()} employees` : "";
  const companyLocation = locationText(obj(company.location).headquarter);
  const hasEnrichment = Object.keys(e).length > 0;

  if (loading && !detail) return <div className="cc-record"><div className="cc-record-loading">Loading full record…</div></div>;

  return (
    <div className="cc-record">
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
    </div>
  );
}
