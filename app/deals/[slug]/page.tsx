// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import "../../deals.css";

type Deal = {
  id: string;
  name: string | null;
  amount: number | null;
  currency: string | null;
  stage: string | null;
  status: string;
  closeDate: string | null;
  contactName: string | null;
  contactEmail: string | null;
  companyName: string | null;
  companyDomain: string | null;
  contactLinkedin: string | null;
  attribution: string;
  attributionReason: string | null;
  attributionMatchedBy: string | null;
  attributionCampaign: string | null;
  leadId: string | null;
  companyLogo: string | null;
  computedAttribution: string;
  dismissed: boolean;
  matchedValue: string | null;
  trace: { check: string; input: string; matched: boolean; detail: string }[];
};
type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type Crm = { provider: string | null; connected: boolean; lastSyncedAt: string | null };
type PipelineStage = { title: string; kind: "won" | "lost" | "open"; color: string | null };
type Pipeline = { stages: PipelineStage[]; discoveredAt: string | null };

function money(value: number | null, currency: string | null): string {
  if (!value) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${Math.round(value).toLocaleString()}`;
  }
}

export default function ClientDealsPage() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<Client | null>(null);
  const [crm, setCrm] = useState<Crm>({ provider: null, connected: false, lastSyncedAt: null });
  const [deals, setDeals] = useState<Deal[]>([]);
  const [pipeline, setPipeline] = useState<Pipeline>({ stages: [], discoveredAt: null });
  const [view, setView] = useState<"board" | "list">("board");
  /** Board narrows to QC-sourced deals with one toggle — the agency's own question, one click. */
  const [qcOnly, setQcOnly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [filter, setFilter] = useState<"all" | "confirmed" | "possible">("all");
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  /** The deal opened in the drawer, and its loaded detail. */
  const [openDeal, setOpenDeal] = useState<Deal | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  // Connect form
  const [provider, setProvider] = useState("hubspot");
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");

  const load = async () => {
    try {
      const response = await fetch(`/api/deals/clients/${encodeURIComponent(slug)}`, { cache: "no-store" });
      if (response.status === 404) { setNotFound(true); setLoading(false); return; }
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.client) {
        setClient(payload.client);
        setCrm(payload.crm ?? { provider: null, connected: false, lastSyncedAt: null });
        setDeals(Array.isArray(payload.deals) ? payload.deals : []);
        setPipeline(payload.pipeline && Array.isArray(payload.pipeline.stages) ? payload.pipeline : { stages: [], discoveredAt: null });
      }
    } catch { /* leave loading */ }
    setLoading(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on slug on purpose.
  useEffect(() => { if (slug) void load(); }, [slug]);

  const connect = async () => {
    if (connecting || !apiKey.trim()) return;
    setConnecting(true);
    setConnectError("");
    try {
      const response = await fetch(`/api/deals/clients/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setConnectError(typeof payload.error === "string" ? payload.error : "Could not connect."); setConnecting(false); return; }
      setApiKey("");
      setConnecting(false);
      await load();
      void sync();
    } catch {
      setConnectError("Could not reach the server.");
      setConnecting(false);
    }
  };

  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    setMessage("Syncing from the CRM…");
    try {
      const response = await fetch("/api/deals/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setMessage(typeof payload.error === "string" ? payload.error : "Sync failed."); setSyncing(false); return; }
      setMessage(`Synced ${payload.synced} deals · ${payload.confirmed} confirmed as QC${payload.possible ? ` · ${payload.possible} to review` : ""}.`);
      setSyncing(false);
      await load();
    } catch {
      setMessage("Could not reach the server.");
      setSyncing(false);
    }
  };

  const shown = useMemo(() => deals.filter((d) => filter === "all" || d.attribution === filter), [deals, filter]);
  const confirmedCount = deals.filter((d) => d.attribution === "confirmed").length;
  const possibleCount = deals.filter((d) => d.attribution === "possible").length;
  const currency = deals.find((d) => d.currency)?.currency ?? null;

  /*
   * The board columns, built from *this client's* pipeline, not a fixed set.
   *
   * Deals are bucketed into the client's own stages by matching the deal's stage title. A deal whose
   * stage is not in the discovered list — a stage renamed since the last sync, say — lands in a trailing
   * "Other" column rather than vanishing, so nothing is ever silently dropped from the board.
   */
  const columns = useMemo(() => {
    const norm = (t: string) => t.trim().toLowerCase();
    const isQc = (d: Deal) => d.attribution === "confirmed" || d.attribution === "possible";
    const pool = qcOnly ? deals.filter(isQc) : deals;

    /*
     * The stage order. Prefer the pipeline discovered from the CRM; when there is none stored yet, fall
     * back to the stages the deals themselves carry, in first-seen order. Either way the board groups by
     * real stages rather than tipping everything into one "Other" column.
     */
    let stages = pipeline.stages;
    if (stages.length === 0) {
      const seen: string[] = [];
      for (const d of deals) if (d.stage && !seen.some((t) => norm(t) === norm(d.stage!))) seen.push(d.stage);
      stages = seen.map((title) => ({ title, kind: /won/i.test(title) ? "won" : /lost|dead/i.test(title) ? "lost" : "open", color: null }));
    }

    const buckets = new Map<string, Deal[]>();
    for (const stage of stages) buckets.set(norm(stage.title), []);
    const other: Deal[] = [];
    for (const deal of pool) {
      const bucket = buckets.get(norm(deal.stage ?? ""));
      if (bucket) bucket.push(deal);
      else other.push(deal);
    }

    const cols = stages.map((stage) => {
      const rowsIn = buckets.get(norm(stage.title)) ?? [];
      return {
        stage,
        deals: rowsIn,
        qc: rowsIn.filter((d) => d.attribution === "confirmed").length,
        value: rowsIn.reduce((s, d) => s + (d.amount || 0), 0),
      };
    });
    if (other.length) cols.push({ stage: { title: "Other", kind: "open" as const, color: null }, deals: other, qc: other.filter((d) => d.attribution === "confirmed").length, value: other.reduce((s, d) => s + (d.amount || 0), 0) });

    // Hide the columns that are empty in the current view — an empty column is noise, not information.
    return cols.filter((col) => col.deals.length > 0);
  }, [deals, pipeline, qcOnly]);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Deals", href: "/deals" }, { label: client?.name || "Client" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="deal-shell">
          {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
          {notFound && !loading && <div className="deal-empty">That client was not found. <Link href="/deals" style={{ color: "var(--accent)" }}>Back</Link>.</div>}

          {client && (
            <>
              <div className="deal-client-head">
                <span className="deal-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
                  {client.logoUrl ? <img src={client.logoUrl} alt="" /> : (client.name[0] || "?").toUpperCase()}
                </span>
                <div style={{ flex: 1 }}>
                  <h1>{client.name}</h1>
                  <Link href="/deals" className="deal-back">← All clients</Link>
                </div>
                {crm.connected && (
                  <div className="deal-head-actions">
                    <div className="deal-head-btns">
                      <button className={`deal-chip ${qcOnly ? "on" : ""}`} onClick={() => setQcOnly((v) => !v)}>
                        {qcOnly ? "✓ QC-sourced only" : "QC-sourced only"}
                      </button>
                      <button className="deal-chip" onClick={() => setLogOpen(true)}>Attribution log</button>
                      <button className="primary-button" onClick={() => void sync()} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
                    </div>
                    <span className="deal-head-synced">{message || (crm.lastSyncedAt ? `Synced ${new Date(crm.lastSyncedAt).toLocaleString()}` : "Not synced yet")}</span>
                  </div>
                )}
              </div>

              {!crm.connected ? (
                <div className="deal-connect">
                  <h3>Connect {client.name}&apos;s CRM</h3>
                  <p>Paste an API key with read access to their deals. Reply Radar pulls the whole pipeline and flags which deals trace back to a person QC contacted or booked.</p>
                  <label htmlFor="provider">Provider</label>
                  <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                    <option value="hubspot">HubSpot</option>
                    <option value="attio">Attio</option>
                  </select>
                  <label htmlFor="apikey">API key</label>
                  <input id="apikey" type="password" value={apiKey} placeholder="Private app token" onChange={(e) => setApiKey(e.target.value)} />
                  <button className="primary-button" onClick={() => void connect()} disabled={connecting || !apiKey.trim()}>{connecting ? "Connecting…" : "Connect & sync"}</button>
                  {connectError && <div className="deal-error">{connectError}</div>}
                </div>
              ) : (
                <>
                  {/* The scorecard: the deals QC sourced, as big as it deserves to be. */}
                  <div className="deal-hero">
                    <div className="deal-hero-big">
                      <span>Deals attributed to QC</span>
                      <b>{confirmedCount}</b>
                    </div>
                    <div className="deal-hero-cell">
                      <span>To review</span>
                      <b className="amber">{possibleCount}</b>
                    </div>
                    <div className="deal-hero-cell">
                      <span>Total deals</span>
                      <b>{deals.length}</b>
                    </div>
                  </div>

                  <div className="deal-toolbar">
                    <div className="deal-viewtabs">
                      <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>Pipeline</button>
                      <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>List</button>
                    </div>
                    {view === "list" && (
                      <div className="deal-filters">
                        <button className={`deal-filter ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All ({deals.length})</button>
                        <button className={`deal-filter ${filter === "confirmed" ? "active" : ""}`} onClick={() => setFilter("confirmed")}>Confirmed ({confirmedCount})</button>
                        <button className={`deal-filter ${filter === "possible" ? "active" : ""}`} onClick={() => setFilter("possible")}>Review ({possibleCount})</button>
                      </div>
                    )}
                  </div>

                  {deals.length === 0 ? (
                    <div className="deal-empty">No deals synced yet. Hit Sync now.</div>
                  ) : view === "board" ? (
                    /* This client's own pipeline, in their own columns and order — discovered at sync. */
                    columns.length === 0 ? (
                      <div className="deal-empty">
                        {qcOnly ? "No QC-sourced deals to show. Toggle off \u201cQC-sourced only\u201d for the full pipeline." : "No deals in this view."}
                      </div>
                    ) : (
                    <div className="deal-board">
                      {columns.map((col) => (
                        <div className={`deal-col kind-${col.stage.kind}`} key={col.stage.title}>
                          <div className="deal-col-head" style={col.stage.color ? { borderTopColor: col.stage.color } : undefined}>
                            <div className="deal-col-title">
                              <b>{col.stage.title}</b>
                              <span>{col.deals.length}</span>
                            </div>
                            <div className="deal-col-sub">
                              {col.qc > 0 && <span className="deal-col-qc">{col.qc} QC</span>}
                              {col.value > 0 && <span>{money(col.value, currency)}</span>}
                            </div>
                          </div>
                          <div className="deal-col-body">
                            {col.deals.length === 0 && <p className="deal-col-empty">—</p>}
                            {col.deals.map((deal) => (
                              <DealCard key={deal.id} deal={deal} currency={currency} money={money} onOpen={() => setOpenDeal(deal)} />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    )
                  ) : (
                    <div className="deal-list">
                      {shown.length === 0 && <div className="deal-empty">Nothing in this view.</div>}
                      {shown.map((deal) => (
                        <div className={`deal-row ${deal.attribution}`} key={deal.id}>
                          <div className="deal-main">
                            <strong>{deal.name || "Untitled deal"}</strong>
                            <span className="deal-sub">{[deal.companyName, deal.contactName || deal.contactEmail].filter(Boolean).join(" · ") || "—"}</span>
                            {deal.attributionReason && <span className={`deal-attr ${deal.attribution === "confirmed" ? "win" : ""}`}>{deal.attributionReason}</span>}
                          </div>
                          <div className="deal-amount">
                            <b>{money(deal.amount, deal.currency)}</b>
                            <span>{deal.stage || deal.status}</span>
                          </div>
                          <div className="deal-badges">
                            <span className={`deal-badge ${deal.attribution}`}>{deal.attribution === "confirmed" ? "QC ✓" : deal.attribution === "possible" ? "Review" : "Not QC"}</span>
                            <span className="deal-badge status">{deal.status}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </main>
      </section>
      {logOpen && <AttributionLog deals={deals} onClose={() => setLogOpen(false)} onOpenDeal={(d) => { setLogOpen(false); setOpenDeal(d); }} />}
      {openDeal && (
        <DealDrawer
          deal={openDeal}
          money={money}
          onClose={() => setOpenDeal(null)}
          onOverride={(dismissed) => {
            setDeals((prev) => prev.map((d) => d.id === openDeal.id ? { ...d, dismissed, attribution: dismissed ? "none" : d.computedAttribution } : d));
            setOpenDeal((prev) => prev ? { ...prev, dismissed, attribution: dismissed ? "none" : prev.computedAttribution } : prev);
          }}
        />
      )}
    </div>
  );
}

/** A board card: the company logo and name, the contact, and the deal value. Everything else — the
 *  conversation, the full lead — opens in the drawer on click. */
function DealCard({ deal, currency, money, onOpen }: { deal: Deal; currency: string | null; money: (v: number | null, c: string | null) => string; onOpen: () => void }) {
  const initial = (deal.companyName || deal.name || "?").trim().charAt(0).toUpperCase();
  return (
    <button className={`dk ${deal.attribution}`} onClick={onOpen} type="button">
      <span className="dk-logo">{deal.companyLogo ? <img src={deal.companyLogo} alt="" /> : initial}</span>
      <span className="dk-id">
        <b>{deal.companyName || deal.name || "Untitled"}</b>
        {deal.contactName && <small>{deal.contactName}</small>}
      </span>
      <span className="dk-amount">{deal.amount ? money(deal.amount, deal.currency || currency) : "—"}</span>
    </button>
  );
}

type Detail = {
  lead: { name: string | null; role: string | null; company: string | null; linkedin: string | null; location: string | null; industry: string | null; headline: string | null; photoUrl: string | null; campaigns: string[]; icpScore: number | null } | null;
  messages: { direction: string; body: string; sentAt: string | null }[];
};

/**
 * Everything about one deal, in a drawer: the lead QC contacted, their company, the campaign, and the
 * whole conversation. The conversation is our mirror of HeyReach — the same messages, read from the
 * database rather than fetched live, so opening a deal is instant.
 */
function DealDrawer({ deal, money, onClose, onOverride }: { deal: Deal; money: (v: number | null, c: string | null) => string; onClose: () => void; onOverride: (dismissed: boolean) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const review = async (dismissed: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/deals/${encodeURIComponent(deal.id)}/override`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ override: dismissed ? "dismissed" : null }),
      });
      if (response.ok) onOverride(dismissed);
    } finally { setSaving(false); }
  };
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch(`/api/deals/detail/${encodeURIComponent(deal.id)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (live && payload.ok) setDetail({ lead: payload.lead, messages: payload.messages ?? [] });
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal.id]);

  const lead = detail?.lead;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

  return (
    <div className="dd-backdrop">
      <button className="dd-scrim" aria-label="Close" onClick={onClose} />
      <aside className="dd-panel" role="dialog" aria-label={deal.companyName || "Deal"}>
        <div className="dd-head">
          <span className="dd-logo">{deal.companyLogo ? <img src={deal.companyLogo} alt="" /> : (deal.companyName || "?").charAt(0).toUpperCase()}</span>
          <div className="dd-head-t">
            <h2>{deal.companyName || deal.name || "Untitled deal"}</h2>
            <span>{[deal.stage, deal.amount ? money(deal.amount, deal.currency) : null].filter(Boolean).join(" · ")}</span>
          </div>
          <button className="dd-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {(deal.attribution !== "none" || deal.dismissed) && (
          <div className={`dd-attr ${deal.dismissed ? "dismissed" : deal.attribution}`}>
            <b>{deal.dismissed ? "Dismissed — not a QC deal" : deal.attribution === "confirmed" ? "Attributed to QC" : "Possible QC deal"}</b>
            {!deal.dismissed && deal.attributionReason && <p>{deal.attributionReason}</p>}
            {!deal.dismissed && deal.matchedValue && (
              <div className="dd-matched">
                <span className="dd-matched-k">Matched on</span>
                <span className="dd-matched-v">{MATCH_LABEL[deal.attributionMatchedBy ?? ""] ?? deal.attributionMatchedBy} · <code>{deal.matchedValue}</code></span>
              </div>
            )}
            {!deal.dismissed && deal.attributionCampaign && <span className="dd-camp">Campaign: {deal.attributionCampaign}</span>}
            <div className="dd-review">
              {deal.dismissed ? (
                <button className="dd-review-btn restore" onClick={() => void review(false)} disabled={saving}>Restore QC attribution</button>
              ) : (
                <button className="dd-review-btn dismiss" onClick={() => void review(true)} disabled={saving}>
                  {saving ? "Saving…" : "Not a QC deal — remove attribution"}
                </button>
              )}
            </div>
          </div>
        )}

        {deal.trace.length > 0 && (
          <details className="dd-trace">
            <summary>How this was decided · {deal.trace.length} checks</summary>
            <ol className="dd-trace-list">
              {deal.trace.map((t, i) => (
                <li key={i} className={t.matched ? "hit" : "miss"}>
                  <span className="dd-trace-mark">{t.matched ? "✓" : "·"}</span>
                  <span className="dd-trace-body">
                    <b>{t.check}</b>
                    <small>{t.input}</small>
                    {t.detail && <em>{t.detail}</em>}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}

        {loading ? (
          <p className="dd-loading">Loading the lead and conversation…</p>
        ) : (
          <>
            {lead ? (
              <div className="dd-section">
                <div className="dd-lead">
                  {lead.photoUrl && <img className="dd-lead-photo" src={lead.photoUrl} alt="" />}
                  <div>
                    <b>{lead.name || "—"}</b>
                    {lead.role && <span>{lead.role}</span>}
                    {lead.headline && <span className="dd-headline">{lead.headline}</span>}
                  </div>
                </div>
                <dl className="dd-facts">
                  {lead.company && <><dt>Company</dt><dd>{lead.company}</dd></>}
                  {lead.industry && <><dt>Industry</dt><dd>{lead.industry}</dd></>}
                  {lead.location && <><dt>Location</dt><dd>{lead.location}</dd></>}
                  {lead.icpScore != null && <><dt>ICP score</dt><dd>{lead.icpScore}</dd></>}
                  {lead.campaigns.length > 0 && <><dt>Campaigns</dt><dd>{lead.campaigns.join(", ")}</dd></>}
                  {lead.linkedin && <><dt>LinkedIn</dt><dd><a href={lead.linkedin} target="_blank" rel="noreferrer noopener">Profile ↗</a></dd></>}
                </dl>
              </div>
            ) : (
              <p className="dd-nolead">No QC lead is matched to this deal, so there is no conversation to show. The attribution is company-level — confirm the person in the CRM to link it.</p>
            )}

            {detail && detail.messages.length > 0 && (
              <div className="dd-section">
                <span className="dd-label">Conversation · {detail.messages.length} messages</span>
                <div className="dd-thread">
                  {detail.messages.map((m, i) => (
                    <div key={i} className={`dd-msg ${m.direction.toLowerCase().includes("in") ? "in" : "out"}`}>
                      <p>{m.body}</p>
                      <time>{when(m.sentAt)}</time>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

const MATCH_LABEL: Record<string, string> = {
  heyreach: "HeyReach — a QC message on record",
  email: "Contact email",
  linkedin: "Contact LinkedIn",
  "name+company": "Contact name at a QC-worked company",
  domain: "Company domain",
  company: "Company name",
};

/**
 * The attribution log: every deal and the exact steps the matcher took, so the reasoning is auditable.
 *
 * It reads the trace already stored on each deal — the same steps re-run on every sync — so opening it is
 * instant and always reflects the most recent sync. Attributed deals first, then the ones under review,
 * then the rest, because the interesting question is usually "why did this one land where it did".
 */
function AttributionLog({ deals, onClose, onOpenDeal }: { deals: Deal[]; onClose: () => void; onOpenDeal: (d: Deal) => void }) {
  const rank = (d: Deal) => (d.attribution === "confirmed" ? 0 : d.attribution === "possible" ? 1 : 2);
  const ordered = [...deals].sort((a, b) => rank(a) - rank(b) || (a.companyName || "").localeCompare(b.companyName || ""));
  return (
    <div className="dd-backdrop">
      <button className="dd-scrim" aria-label="Close" onClick={onClose} />
      <aside className="dd-panel dd-log" role="dialog" aria-label="Attribution log">
        <div className="dd-head">
          <div className="dd-head-t"><h2>Attribution log</h2><span>Every deal, and exactly how it was judged · re-run each sync</span></div>
          <button className="dd-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="dd-log-list">
          {ordered.map((deal) => {
            const decisive = deal.trace.find((t) => t.matched);
            return (
              <button key={deal.id} className="dd-log-row" onClick={() => onOpenDeal(deal)} type="button">
                <span className="dd-log-top">
                  <span className={`dd-log-badge ${deal.attribution}`}>{deal.attribution === "confirmed" ? "QC ✓" : deal.attribution === "possible" ? "Review" : "Not QC"}</span>
                  <b>{deal.companyName || deal.name || "Untitled"}</b>
                  {deal.dismissed && <span className="dd-log-dismissed">dismissed</span>}
                </span>
                <span className="dd-log-line">
                  {decisive ? `${decisive.check} → ${decisive.detail || "matched"}` : `${deal.trace.length} checks, nothing matched`}
                </span>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

