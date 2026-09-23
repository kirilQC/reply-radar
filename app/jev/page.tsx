// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppSidebar from "../components/AppSidebar";
import Crumb from "../components/Crumb";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import "../jev.css";

type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; hasQuestions: boolean; questionCount: number };

function ClientCard({ client }: { client: Client }) {
  return (
    <Link href={`/jev/${client.slug}`} className={`jev-card ${client.hasQuestions ? "is-ready" : ""}`}>
      <span className="jev-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
        {client.logoUrl ? <img src={client.logoUrl} alt="" /> : (client.name[0] || "?").toUpperCase()}
      </span>
      <span className="jev-card-name">{client.name}</span>
      <span className="jev-count">
        <b>{client.questionCount}</b>
        <span>{client.hasQuestions ? (client.questionCount === 1 ? "question" : "questions") : "not set up"}</span>
      </span>
    </Link>
  );
}

export default function JevDirectoryPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/jev/clients", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(payload.clients)) setClients(payload.clients);
        else setError(payload.error || `Could not load clients (${response.status}).`);
      } catch {
        setError("Could not reach the server.");
      }
      setLoading(false);
    })();
  }, []);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Jev" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="jev-shell">
          <div className="jev-heading">
            <h1>Jev list check</h1>
          </div>
          {error && <div className="jev-banner is-error">{error}</div>}
          {!loading && !error && clients.length === 0 && <div className="jev-empty">No clients yet.</div>}
          {clients.length > 0 && <div className="jev-directory">{clients.map((client) => <ClientCard key={client.id} client={client} />)}</div>}
        </main>
      </section>
    </div>
  );
}
