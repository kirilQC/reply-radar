// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
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
type Campaign = { id: string; name: string; status: string; listSize: number; fetched: number; enriched: number; job: { status: string; leadsFetched: number; leadsEnriched: number; total: number } | null };

const RESULTS = ["Connected", "Voicemail", "No answer", "Interested", "Callback", "Not interested", "Bad number", "Do not call"];

const scoreClass = (score: number | null) => (score == null ? "none" : score >= 70 ? "hot" : score >= 40 ? "warm" : "cool");

export default function ClientCallList() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<{ name: string; slug: string } | null>(null);
  const [leads, setLeads] = useState<CallLead[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [caller, setCaller] = useState("");
  const [campaignsOpen, setCampaignsOpen] = useState(true);
  const [phoneOnly, setPhoneOnly] = useState(false);
  const [logOpen, setLogOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
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

  // While a fetch/enrich job is running, refresh so its progress and new leads appear.
  const anyJobActive = campaigns.some((c) => c.job && c.job.status !== "done" && c.job.status !== "error");
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (anyJobActive) pollRef.current = setInterval(() => void load(), 9000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyJobActive, slug]);

  const setCallerName = (value: string) => { setCaller(value); try { localStorage.setItem("cc-caller", value); } catch { /* ignore */ } };

  const fetchCampaign = async (c: Campaign) => {
    setBusy(c.id);
    await fetch("/api/cold-calling/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, campaignId: c.id, campaignName: c.name }) }).catch(() => {});
    setBusy(""); await load();
  };

  const saveLog = async (leadId: string, result: string, notes: string) => {
    setBusy(leadId);
    await fetch("/api/cold-calling/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leadId, caller, result, notes }) }).catch(() => {});
    setBusy(""); setLogOpen(null); await load();
  };

  const shown = phoneOnly ? leads.filter((l) => l.phone) : leads;

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Cold calling", href: "/cold-calling" }, { label: client?.name || "Client" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="cc-shell cc-shell-wide">
          {loading && <p className="cc-muted">Loading call list…</p>}
          {notFound && !loading && <div className="cc-empty">That client was not found. <Link href="/cold-calling" style={{ color: "var(--accent)" }}>Back</Link>.</div>}

          {client && (
            <>
              <div className="cc-client-head">
                <div>
                  <Link href="/cold-calling" className="cc-back">← All clients</Link>
                  <h1>{client.name}</h1>
                </div>
                <div className="cc-head-actions">
                  <label className="cc-caller">Calling as<input value={caller} placeholder="Your name" onChange={(e) => setCallerName(e.target.value)} /></label>
                  <a className="cc-export" href={`/api/cold-calling/export?slug=${encodeURIComponent(slug)}`}>Export CSV</a>
                </div>
              </div>

              {/* Campaigns — fetch & enrich the non-repliers, one campaign at a time */}
              <div className="cc-campaigns">
                <button type="button" className={`cc-campaigns-head ${campaignsOpen ? "open" : ""}`} onClick={() => setCampaignsOpen((v) => !v)}>
                  <span className="cc-caret" aria-hidden>▸</span>
                  <span>Pull leads from a campaign</span>
                  <span className="cc-muted">{campaigns.length} campaigns</span>
                </button>
                {campaignsOpen && (
                  <div className="cc-campaign-list">
                    {campaigns.length === 0 && <p className="cc-muted" style={{ padding: "6px 2px" }}>No campaigns found for this client.</p>}
                    {campaigns.map((c) => {
                      const running = c.job && c.job.status !== "done" && c.job.status !== "error";
                      return (
                        <div className="cc-campaign" key={c.id}>
                          <div className="cc-campaign-main">
                            <strong>{c.name}</strong>
                            <span className="cc-muted">{c.listSize} leads · {c.fetched} fetched · {c.enriched} enriched{c.status ? ` · ${c.status.toLowerCase()}` : ""}</span>
                          </div>
                          {running ? (
                            <span className="cc-job">{
                              c.job?.status === "queued" ? "Queued…"
                                : c.job?.status === "fetching" ? `Fetching ${c.job.leadsFetched}/${c.job.total || c.listSize}…`
                                : `Enriching ${c.job?.leadsEnriched}/${c.job?.leadsFetched}…`
                            }</span>
                          ) : (
                            <button type="button" className="cc-fetch" disabled={busy === c.id} onClick={() => void fetchCampaign(c)}>{c.fetched > 0 ? "Refresh & enrich" : "Fetch & enrich"}</button>
                          )}
                        </div>
                      );
                    })}
                    <p className="cc-note">Fetching pulls everyone in the campaign and reveals a mobile number for each (uses AI Ark credits). It runs in the background — leads appear here as they finish.</p>
                  </div>
                )}
              </div>

              {/* The call list */}
              <div className="cc-list-head">
                <span>{shown.length} leads · sorted by ICP score</span>
                <label className="cc-toggle"><input type="checkbox" checked={phoneOnly} onChange={(e) => setPhoneOnly(e.target.checked)} /> With a number only</label>
              </div>

              <div className="cc-list">
                {shown.length === 0 && <div className="cc-empty">No leads yet. Pull a campaign above to build the list.</div>}
                {shown.map((lead) => (
                  <div className="cc-lead" key={lead.id}>
                    <div className="cc-lead-main">
                      <span className={`cc-score ${scoreClass(lead.icpScore)}`} title={lead.icpReason || undefined}>{lead.icpScore ?? "—"}</span>
                      <div className="cc-lead-who">
                        <strong>{lead.name}{lead.linkedin && <a className="cc-li" href={lead.linkedin} target="_blank" rel="noreferrer">in</a>}</strong>
                        <span className="cc-lead-sub">{[lead.title, lead.company].filter(Boolean).join(" · ") || "—"}</span>
                        <div className="cc-lead-meta">
                          <span className={`cc-activity ${lead.replied ? "replied" : ""}`}>{lead.activity}</span>
                          {lead.campaign && <span className="cc-chip">{lead.campaign}</span>}
                          {lead.callCount > 0 && <span className="cc-chip done">{lead.callCount} logged</span>}
                        </div>
                      </div>
                      <div className="cc-lead-right">
                        {lead.phone ? <a className="cc-phone" href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`}>{lead.phone}</a> : <span className="cc-nophone">No number</span>}
                        <button type="button" className="cc-logbtn" onClick={() => setLogOpen(logOpen === lead.id ? null : lead.id)}>{logOpen === lead.id ? "Cancel" : "Log call"}</button>
                      </div>
                    </div>
                    {lead.lastCall && logOpen !== lead.id && (
                      <div className="cc-lastcall">Last: <b>{lead.lastCall.result || "logged"}</b>{lead.lastCall.caller ? ` by ${lead.lastCall.caller}` : ""}{lead.lastCall.notes ? ` — ${lead.lastCall.notes}` : ""}</div>
                    )}
                    {logOpen === lead.id && <LogForm busy={busy === lead.id} onSave={(result, notes) => void saveLog(lead.id, result, notes)} />}
                  </div>
                ))}
              </div>
            </>
          )}
        </main>
      </section>
    </div>
  );
}

function LogForm({ onSave, busy }: { onSave: (result: string, notes: string) => void; busy: boolean }) {
  const [result, setResult] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <div className="cc-logform">
      <div className="cc-results">
        {RESULTS.map((r) => (
          <button type="button" key={r} className={`cc-result ${result === r ? "is-on" : ""}`} onClick={() => setResult(r)}>{r}</button>
        ))}
      </div>
      <textarea value={notes} placeholder="What happened on the call…" rows={2} onChange={(e) => setNotes(e.target.value)} />
      <div className="cc-logform-actions">
        <button type="button" className="cc-save" disabled={busy || (!result && !notes.trim())} onClick={() => onSave(result, notes)}>{busy ? "Saving…" : "Save call"}</button>
      </div>
    </div>
  );
}
