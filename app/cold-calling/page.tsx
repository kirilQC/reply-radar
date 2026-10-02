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
import Skeleton from "../components/Skeleton";

type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; callable: number; withPhone: number };

export default function ColdCallingDirectory() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed read is kept apart from an empty answer: "No clients yet" on a network blip sends people
  // off to check HeyReach connections that are fine.
  const [error, setError] = useState("");

  const loadClients = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/cold-calling/clients", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok || !Array.isArray(payload.clients)) throw new Error(String(payload.error || `The client list could not be loaded (${response.status}).`));
      setClients(payload.clients);
    } catch (failure) {
      setError(failure instanceof Error && failure.message !== "Failed to fetch" ? failure.message : "The client list could not be loaded. Check your connection.");
    }
    setLoading(false);
  };

  useEffect(() => { void loadClients(); }, []);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Cold calling" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="cc-shell cc-directory-shell">
          <div className="cc-heading">
            <h1>Cold calling</h1>
          </div>
          {loading && <Skeleton variant="logo-cards" count={12} label="Loading clients" />}
          {!loading && error && (
            <div className="cc-empty" role="alert">
              {error} <button type="button" className="text-button" onClick={() => void loadClients()}>Retry</button>
            </div>
          )}
          {!loading && !error && clients.length === 0 && <div className="cc-empty">No clients with a HeyReach connection yet.</div>}
          <div className="cc-directory">
            {clients.map((c) => (
              <Link href={`/cold-calling/${encodeURIComponent(c.slug)}`} className="cc-card" key={c.id}>
                <span className="cc-logo" style={c.logoUrl ? undefined : { background: c.accentColor || "var(--accent)" }}>
                  {c.logoUrl ? <img src={c.logoUrl} alt="" /> : (c.name[0] || "?").toUpperCase()}
                </span>
                <span className="cc-card-name">{c.name}</span>
              </Link>
            ))}
          </div>
        </main>
      </section>
    </div>
  );
}
