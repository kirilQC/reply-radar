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
  phone: string | null; icpScore: number | null; icpReason: string | null; replied: boolean;
  campaign: string | null; activity: string; lastCall: { caller: string | null; result: string | null; notes: string | null; at: string } | null; callCount: number;
};
type Campaign = { id: string; name: string; status: string; listSize: number; fetched: number; enriched: number; job: { status: string; leadsFetched: number; leadsEnriched: number; total: number; error: string | null } | null };

const RESULTS = ["Connected", "Voicemail", "No answer", "Interested", "Callback", "Not interested", "Bad number", "Do not call"];
const scoreClass = (s: number | null) => (s == null ? "none" : s >= 70 ? "hot" : s >= 40 ? "warm" : "cool");
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, "")}`;
const pct = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0);

export default function ClientCallList() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<{ name: string; slug: string } | null>(null);
  const [leads, setLeads] = useState<CallLead[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [caller, setCaller] = useState("");
  const [campaignsOpen, setCampaignsOpen] = useState(false);
  const [phoneOnly, setPhoneOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  useEffect(() => { try { setCaller(localStorage.getItem("cc-caller") || ""); } catch { /* ignore */ } }, []);

  const anyJobActive = campaigns.some((c) => c.job && c.job.status !== "done" && c.job.status !== "error");
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (anyJobActive) { setCampaignsOpen(true); pollRef.current = setInterval(() => void load(), 6000); }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyJobActive, slug]);

  const queue = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads.filter((l) => (!phoneOnly || l.phone) && (!q || `${l.name} ${l.company ?? ""} ${l.title ?? ""}`.toLowerCase().includes(q)));
  }, [leads, phoneOnly, query]);

  // Keep a valid selection: default to the top of the queue.
  useEffect(() => {
    if (queue.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !queue.some((l) => l.id === selectedId)) setSelectedId(queue[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  const current = queue.find((l) => l.id === selectedId) ?? null;
  const setCallerName = (v: string) => { setCaller(v); try { localStorage.setItem("cc-caller", v); } catch { /* ignore */ } };

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
    await fetch("/api/cold-calling/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leadId, caller, result, notes }) }).catch(() => {});
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
              <div className="cc-client-head">
                <div className="cc-client-titles">
                  <Link href="/cold-calling" className="cc-back">← All clients</Link>
                  <h1>{client.name}</h1>
                </div>
                <div className="cc-head-actions">
                  <label className="cc-caller">Calling as<input value={caller} placeholder="Your name" onChange={(e) => setCallerName(e.target.value)} /></label>
                  <a className="cc-export" href={`/api/cold-calling/export?slug=${encodeURIComponent(slug)}`}>Export CSV</a>
                </div>
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

              {leads.length === 0 ? (
                <div className="cc-empty">No leads yet. Open “Pull leads from a campaign” above to build your list.</div>
              ) : (
                <div className="cc-cockpit-grid">
                  {/* The current lead — the one you are calling */}
                  <section className="cc-current">
                    {current ? (
                      <CurrentLead lead={current} caller={caller} busy={busy} onSave={(r, n, next) => void saveAndNext(current.id, r, n, next)} onSkip={advance} />
                    ) : (
                      <div className="cc-empty">No leads match your filter.</div>
                    )}
                  </section>

                  {/* The queue */}
                  <aside className="cc-queue">
                    <div className="cc-queue-head">
                      <input className="cc-search" value={query} placeholder="Search name or company…" onChange={(e) => setQuery(e.target.value)} />
                      <label className="cc-toggle"><input type="checkbox" checked={phoneOnly} onChange={(e) => setPhoneOnly(e.target.checked)} /> With a number</label>
                    </div>
                    <div className="cc-queue-count">{queue.length} in queue · by ICP score</div>
                    <div className="cc-queue-list">
                      {queue.map((l) => (
                        <button type="button" key={l.id} className={`cc-queue-item ${l.id === selectedId ? "is-current" : ""} ${l.callCount > 0 ? "is-done" : ""}`} onClick={() => setSelectedId(l.id)}>
                          <span className={`cc-qscore ${scoreClass(l.icpScore)}`}>{l.icpScore ?? "—"}</span>
                          <span className="cc-qwho"><b>{l.name}</b><em>{[l.title, l.company].filter(Boolean).join(" · ") || "—"}</em></span>
                          {l.callCount > 0 ? <span className="cc-qtick">✓</span> : l.phone ? <span className="cc-qphone">☎</span> : null}
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

function CurrentLead({ lead, caller, busy, onSave, onSkip }: { lead: CallLead; caller: string; busy: boolean; onSave: (result: string, notes: string, next: boolean) => void; onSkip: () => void }) {
  const [result, setResult] = useState("");
  const [notes, setNotes] = useState("");
  // Reset the form whenever the lead changes.
  useEffect(() => { setResult(""); setNotes(""); }, [lead.id]);

  return (
    <div className="cc-current-inner">
      <div className="cc-current-top">
        <span className={`cc-score-lg ${scoreClass(lead.icpScore)}`}>{lead.icpScore ?? "—"}</span>
        <div className="cc-current-id">
          <h2>{lead.name}{lead.linkedin && <a className="cc-li" href={lead.linkedin} target="_blank" rel="noreferrer">in</a>}</h2>
          <p>{[lead.title, lead.company].filter(Boolean).join(" · ") || "Role and company not recorded"}</p>
          <div className="cc-current-meta">
            <span className={`cc-activity ${lead.replied ? "replied" : ""}`}>{lead.activity}</span>
            {lead.campaign && <span className="cc-chip">{lead.campaign}</span>}
            {lead.callCount > 0 && <span className="cc-chip done">{lead.callCount} call{lead.callCount === 1 ? "" : "s"} logged</span>}
          </div>
        </div>
      </div>

      <div className="cc-phone-row">
        {lead.phone ? (
          <a className="cc-phone-lg" href={telHref(lead.phone)}>☎ {lead.phone}</a>
        ) : (
          <span className="cc-nophone-lg">No phone number for this lead</span>
        )}
      </div>

      {lead.icpReason && <p className="cc-reason"><b>Why this score:</b> {lead.icpReason}</p>}
      {lead.lastCall && (
        <div className="cc-lastcall">Last call: <b>{lead.lastCall.result || "logged"}</b>{lead.lastCall.caller ? ` by ${lead.lastCall.caller}` : ""}{lead.lastCall.notes ? ` — “${lead.lastCall.notes}”` : ""}</div>
      )}

      <div className="cc-logblock">
        <div className="cc-log-label">Log the result{caller ? ` · as ${caller}` : ""}</div>
        <div className="cc-results">
          {RESULTS.map((r) => (
            <button type="button" key={r} className={`cc-result ${result === r ? "is-on" : ""}`} onClick={() => setResult((cur) => (cur === r ? "" : r))}>{r}</button>
          ))}
        </div>
        <textarea value={notes} placeholder="What happened on the call…" rows={3} onChange={(e) => setNotes(e.target.value)} />
        <div className="cc-log-actions">
          <button type="button" className="cc-skip" onClick={onSkip}>Skip →</button>
          <button type="button" className="cc-savenext" disabled={busy || (!result && !notes.trim())} onClick={() => onSave(result, notes, true)}>{busy ? "Saving…" : "Save & next →"}</button>
        </div>
      </div>
    </div>
  );
}
