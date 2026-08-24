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
  attribution: string;
  attributionReason: string | null;
  attributionMatchedBy: string | null;
  attributionCampaign: string | null;
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
  const confirmedValue = deals.filter((d) => d.attribution === "confirmed").reduce((s, d) => s + (d.amount || 0), 0);
  const totalValue = deals.reduce((s, d) => s + (d.amount || 0), 0);
  const currency = deals.find((d) => d.currency)?.currency ?? null;
  const anyValue = deals.some((d) => d.amount);

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
                {crm.connected && <button className="primary-button" onClick={() => void sync()} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>}
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
                  {/* The hero: the agency's own scorecard — how much of this pipeline traces to QC. */}
                  <div className="deal-hero">
                    <div className="deal-hero-big">
                      <span>Pipeline sourced by QC</span>
                      <b>{anyValue ? money(confirmedValue, currency) : confirmedCount}</b>
                      <small>{anyValue ? `${confirmedCount} confirmed deal${confirmedCount === 1 ? "" : "s"}` : "confirmed deals — connect deal values in the CRM to see the sum"}</small>
                    </div>
                    <div className="deal-hero-cell">
                      <span>To review</span>
                      <b className="amber">{possibleCount}</b>
                      <small>same company, unconfirmed person</small>
                    </div>
                    <div className="deal-hero-cell">
                      <span>Total pipeline</span>
                      <b>{anyValue ? money(totalValue, currency) : deals.length}</b>
                      <small>{anyValue ? `${deals.length} deals` : "deals synced"}</small>
                    </div>
                  </div>

                  <div className="deal-toolbar">
                    <div className="deal-viewtabs">
                      <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>Pipeline</button>
                      <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>List</button>
                    </div>
                    <div className="deal-toolbar-right">
                      {view === "board" ? (
                        <button className={`deal-chip ${qcOnly ? "on" : ""}`} onClick={() => setQcOnly((v) => !v)}>
                          {qcOnly ? "✓ QC-sourced only" : "QC-sourced only"}
                        </button>
                      ) : (
                        <div className="deal-filters">
                          <button className={`deal-filter ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All ({deals.length})</button>
                          <button className={`deal-filter ${filter === "confirmed" ? "active" : ""}`} onClick={() => setFilter("confirmed")}>Confirmed ({confirmedCount})</button>
                          <button className={`deal-filter ${filter === "possible" ? "active" : ""}`} onClick={() => setFilter("possible")}>Review ({possibleCount})</button>
                        </div>
                      )}
                      <span className="deal-synced">{message || (crm.lastSyncedAt ? `Synced ${new Date(crm.lastSyncedAt).toLocaleString()}` : "Not synced yet")}</span>
                    </div>
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
                              <DealCard key={deal.id} deal={deal} currency={currency} money={money} />
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
    </div>
  );
}

/** One deal on the board: company, who, the attribution proof, value, and its status badge. */
function DealCard({ deal, currency, money }: { deal: Deal; currency: string | null; money: (v: number | null, c: string | null) => string }) {
  const attr = deal.attribution;
  return (
    <div className={`dk ${attr}`}>
      <div className="dk-top">
        <b>{deal.companyName || deal.name || "Untitled"}</b>
        {deal.amount ? <span className="dk-val">{money(deal.amount, deal.currency || currency)}</span> : null}
      </div>
      {(deal.contactName || deal.contactEmail) && <span className="dk-who">{deal.contactName || deal.contactEmail}</span>}
      {attr !== "none" && deal.attributionReason && (
        <span className={`dk-attr ${attr}`}><i />{deal.attributionReason}</span>
      )}
      <div className="dk-foot">
        {attr === "confirmed" && <span className="dk-tag qc">QC ✓</span>}
        {attr === "possible" && <span className="dk-tag review">Review</span>}
        <span className={`dk-tag status ${deal.status}`}>{deal.status}</span>
      </div>
    </div>
  );
}

