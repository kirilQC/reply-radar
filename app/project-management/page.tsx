// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import Link from "next/link";
import AppSidebar from "../components/AppSidebar";
import Crumb from "../components/Crumb";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import "./project-management.css";

type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };

export default function ProjectManagementDirectory() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const payload = await fetch("/api/project-management/clients", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
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
          <Crumb trail={[{ label: "Project management" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="pm-shell pm-directory-shell">
          <div className="pm-heading"><h1>Project management</h1></div>
          {loading && <p className="pm-muted">Loading…</p>}
          {!loading && clients.length === 0 && <div className="pm-empty">No clients yet.</div>}
          <div className="pm-directory">
            {clients.map((c) => (
              <Link href={`/project-management/${encodeURIComponent(c.slug)}`} className="pm-card" key={c.id}>
                <span className="pm-logo" style={c.logoUrl ? undefined : { background: c.accentColor || "var(--accent)" }}>
                  {c.logoUrl ? <img src={c.logoUrl} alt="" /> : (c.name[0] || "?").toUpperCase()}
                </span>
                <span className="pm-card-name">{c.name}</span>
              </Link>
            ))}
          </div>
        </main>
      </section>
    </div>
  );
}
