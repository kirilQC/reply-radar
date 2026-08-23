// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppSidebar from "../components/AppSidebar";
import Crumb from "../components/Crumb";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import "../meetings.css";

type Client = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  accentColor: string | null;
  total: number;
  upcoming: number;
  nextAt: string | null;
  lastAt: string | null;
};

function ClientCard({ client }: { client: Client }) {
  return (
    <Link href={`/meetings/${client.slug}`} className={`mtg-card ${client.total > 0 ? "has-meetings" : ""}`}>
      <span className="mtg-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
        {client.logoUrl ? <img src={client.logoUrl} alt="" /> : (client.name[0] || "?").toUpperCase()}
      </span>
      <span className="mtg-card-name">{client.name}</span>
      <span className="mtg-count">
        <b>{client.total}</b>
        <span>{client.total === 1 ? "meeting" : "meetings"}</span>
      </span>
    </Link>
  );
}

export default function MeetingsDirectoryPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/meetings/clients", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(payload.clients)) setClients(payload.clients);
      } catch { /* leave the empty state */ }
      setLoading(false);
    })();
  }, []);


  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Meetings" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="mtg-shell">
          <div className="mtg-heading">
            <h1>Booked meetings</h1>
          </div>

          {!loading && clients.length === 0 && (
            <div className="mtg-directory"><div className="mtg-empty">No clients yet.</div></div>
          )}
          {clients.length > 0 && (
            <div className="mtg-directory">{clients.map((client) => <ClientCard key={client.id} client={client} />)}</div>
          )}
        </main>
      </section>
    </div>
  );
}
