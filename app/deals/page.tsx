// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppSidebar from "../components/AppSidebar";
import Crumb from "../components/Crumb";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import "../deals.css";

type Client = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  accentColor: string | null;
  crmProvider: string | null;
  lastSyncedAt: string | null;
  total: number;
  confirmed: number;
  possible: number;
  confirmedValue: number;
  totalValue: number;
};

function money(value: number): string {
  if (!value) return "$0";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  } catch {
    return `$${Math.round(value).toLocaleString()}`;
  }
}

function ClientCard({ client }: { client: Client }) {
  return (
    <Link href={`/deals/${client.slug}`} className="deal-card">
      <div className="deal-card-top">
        <span className="deal-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
          {client.logoUrl ? <img src={client.logoUrl} alt="" /> : (client.name[0] || "?").toUpperCase()}
        </span>
        <span className="deal-card-name">
          <strong>{client.name}</strong>
          <small>{client.crmProvider ? client.crmProvider.toUpperCase() : "No CRM"}</small>
        </span>
        <span className={`deal-crm ${client.crmProvider ? "on" : "off"}`}>{client.crmProvider ? "Connected" : "Connect"}</span>
      </div>
      <div className="deal-headline">
        <span>{money(client.confirmedValue)}</span>
        <small>attributed to QC{client.confirmed ? ` · ${client.confirmed} deal${client.confirmed === 1 ? "" : "s"}` : ""}</small>
      </div>
      <div className="deal-card-foot">
        {client.possible > 0 ? <span>{client.possible} to review</span> : <span>&nbsp;</span>}
        {client.total > 0 && <span className="deal-card-count">{client.total} deals synced</span>}
      </div>
    </Link>
  );
}

export default function DealsDirectoryPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/deals/clients", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(payload.clients)) setClients(payload.clients);
      } catch { /* empty state */ }
      setLoading(false);
    })();
  }, []);


  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Deals" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="deal-shell">
          <div className="deal-heading">
            <h1>Deals &amp; attribution</h1>
          </div>
          {!loading && clients.length === 0 && <div className="deal-directory"><div className="deal-empty">No clients yet.</div></div>}
          {clients.length > 0 && (() => {
            const connected = clients.filter((c) => c.crmProvider);
            const pending = clients.filter((c) => !c.crmProvider);
            return (
              <>
                {connected.length > 0 && (
                  <section className="deal-group">
                    <div className="deal-group-head"><span>CRM connected</span><span>{connected.length}</span></div>
                    <div className="deal-directory">{connected.map((c) => <ClientCard key={c.id} client={c} />)}</div>
                  </section>
                )}
                {pending.length > 0 && (
                  <section className="deal-group">
                    <div className="deal-group-head"><span>Not connected yet</span><span>{pending.length}</span></div>
                    <div className="deal-directory">{pending.map((c) => <ClientCard key={c.id} client={c} />)}</div>
                  </section>
                )}
              </>
            );
          })()}
        </main>
      </section>
    </div>
  );
}
