// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import Link from "next/link";
import AppSidebar from "../components/AppSidebar";
import Crumb from "../components/Crumb";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import "../cold-calling.css";

type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; callable: number; withPhone: number };

export default function ColdCallingDirectory() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const payload = await fetch("/api/cold-calling/clients", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
        if (payload.ok && Array.isArray(payload.clients)) setClients(payload.clients);
      } catch { /* empty */ }
      setLoading(false);
    })();
  }, []);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Cold calling" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="cc-shell">
          <div className="cc-heading">
            <h1>Cold calling</h1>
            <p>Pick a client, work down their call list, and log every result.</p>
          </div>
          {loading && <p className="cc-muted">Loading…</p>}
          {!loading && clients.length === 0 && <div className="cc-empty">No clients with a HeyReach connection yet.</div>}
          <div className="cc-directory">
            {clients.map((c) => (
              <Link href={`/cold-calling/${encodeURIComponent(c.slug)}`} className="cc-card" key={c.id}>
                <span className="cc-logo" style={c.logoUrl ? undefined : { background: c.accentColor || "var(--accent)" }}>
                  {c.logoUrl ? <img src={c.logoUrl} alt="" /> : (c.name[0] || "?").toUpperCase()}
                </span>
                <span className="cc-card-name">{c.name}</span>
                <span className="cc-card-count"><b>{c.callable}</b> to call{c.withPhone ? <em>{c.withPhone} with a number</em> : null}</span>
              </Link>
            ))}
          </div>
        </main>
      </section>
    </div>
  );
}
