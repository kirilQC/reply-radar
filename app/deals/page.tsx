// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppSidebar from "../components/AppSidebar";
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
        <span>{client.total} in pipeline · {money(client.totalValue)}</span>
        {client.possible > 0 && <span>{client.possible} to review</span>}
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

  const attributed = clients.reduce((sum, c) => sum + c.confirmedValue, 0);
  const connected = clients.filter((c) => c.crmProvider).length;

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <div className="eyebrow" style={{ fontSize: 9, letterSpacing: ".14em", color: "var(--muted-2)", fontWeight: 700, textTransform: "uppercase" }}>Deals</div>
        </header>
        <main className="deal-shell">
          <div className="deal-heading">
            <div>
              <h1>Deals &amp; attribution</h1>
              <p>{loading ? "Loading…" : `${money(attributed)} of client pipeline traced to QC · ${connected} CRM${connected === 1 ? "" : "s"} connected`}</p>
            </div>
          </div>
          {!loading && clients.length === 0 && <div className="deal-directory"><div className="deal-empty">No clients yet.</div></div>}
          {clients.length > 0 && <div className="deal-directory">{clients.map((c) => <ClientCard key={c.id} client={c} />)}</div>}
        </main>
      </section>
    </div>
  );
}
