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
                  <div className="deal-summary">
                    <div className="deal-stat win"><span>Attributed to QC</span><b>{money(confirmedValue, null)}</b></div>
                    <div className="deal-stat"><span>Confirmed deals</span><b>{confirmedCount}</b></div>
                    <div className="deal-stat"><span>Total pipeline</span><b>{money(totalValue, null)}</b></div>
                    <div className="deal-stat"><span>All deals</span><b>{deals.length}</b></div>
                  </div>

                  <div className="deal-toolbar">
                    <div className="deal-filters">
                      <button className={`deal-filter ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All ({deals.length})</button>
                      <button className={`deal-filter ${filter === "confirmed" ? "active" : ""}`} onClick={() => setFilter("confirmed")}>Confirmed ({confirmedCount})</button>
                      <button className={`deal-filter ${filter === "possible" ? "active" : ""}`} onClick={() => setFilter("possible")}>Review ({possibleCount})</button>
                    </div>
                    <span className="deal-synced">{message || (crm.lastSyncedAt ? `Synced ${new Date(crm.lastSyncedAt).toLocaleString()}` : "Not synced yet")}</span>
                  </div>

                  <div className="deal-list">
                    {shown.length === 0 && <div className="deal-empty">{deals.length === 0 ? "No deals synced yet. Hit Sync now." : "Nothing in this view."}</div>}
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
                </>
              )}
            </>
          )}
        </main>
      </section>
    </div>
  );
}
