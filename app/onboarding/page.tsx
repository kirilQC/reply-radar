// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppSidebar from "../components/AppSidebar";
import Crumb from "../components/Crumb";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";

type Progress = { doneLeaves: number; totalLeaves: number; pct: number; complete: boolean };
type Client = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  accentColor: string | null;
  status: string | null;
  progress: Progress;
};

function ClientCard({ client }: { client: Client }) {
  const { pct, doneLeaves, totalLeaves } = client.progress;
  const done = client.progress.complete;
  const started = !done && doneLeaves > 0;
  return (
    <Link href={`/onboarding/${client.slug}`} className="onb-card">
      <div className="onb-card-top">
        <span className="onb-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
          {client.logoUrl ? <img src={client.logoUrl} alt="" /> : (client.name[0] || "?").toUpperCase()}
        </span>
        <span className="onb-card-name">
          <strong>{client.name}</strong>
        </span>
        <span className={`onb-status ${done ? "complete" : started ? "in_progress" : "not_started"}`}>{done ? "Complete" : started ? "In progress" : "Not started"}</span>
      </div>
      <div className={`onb-progress ${done ? "done" : ""}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="onb-progress-meta">
        <span><b>{doneLeaves}</b> / {totalLeaves} steps</span>
        <b>{pct}%</b>
      </div>
    </Link>
  );
}

export default function OnboardingDirectoryPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [accent, setAccent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/onboarding/clients", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(payload.clients)) setClients(payload.clients);
      } catch { /* leave the empty state */ }
      setLoading(false);
    })();
  }, []);

  const addClient = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/onboarding/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, accentColor: accent.trim() || undefined }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.client) {
        setError(typeof payload.error === "string" ? payload.error : "Could not add the client.");
        setSaving(false);
        return;
      }
      try { window.dispatchEvent(new Event("reply-radar-workspaces-changed")); } catch { /* non-browser */ }
      router.push(`/onboarding/${payload.client.slug}`);
    } catch {
      setError("Could not reach the server. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Onboarding" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="onboarding-shell">
          <div className="onboarding-heading">
            <h1>Client onboarding</h1>
            <div className="onb-actions">
              <Link href="/onboarding/template" className="secondary-button">Edit template</Link>
              <button className="primary-button" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "Add new client"}</button>
            </div>
          </div>

          {adding && (
            <div className="onb-add">
              <div className="onb-field">
                <label htmlFor="onb-name">Client name</label>
                <input
                  id="onb-name"
                  value={name}
                  placeholder="e.g. Bluevia Health"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void addClient(); }}
                />
              </div>
              <div className="onb-field">
                <label htmlFor="onb-accent">Accent (optional)</label>
                <input id="onb-accent" value={accent} placeholder="#8b7cff" onChange={(e) => setAccent(e.target.value)} />
              </div>
              <button className="primary-button" onClick={() => void addClient()} disabled={saving || !name.trim()}>
                {saving ? "Creating…" : "Create client"}
              </button>
              {error && <div className="onb-error" style={{ gridColumn: "1 / -1" }}>{error}</div>}
            </div>
          )}

          {(() => {
            const active = clients.filter((c) => !c.progress.complete);
            const completed = clients.filter((c) => c.progress.complete);
            return (
              <>
                {!loading && clients.length === 0 && (
                  <div className="onb-directory"><div className="onb-empty">No clients yet. Add your first one to start its checklist.</div></div>
                )}
                {active.length > 0 && (
                  <div className="onb-directory">{active.map((c) => <ClientCard key={c.id} client={c} />)}</div>
                )}
                {completed.length > 0 && (
                  <>
                    <button className="onb-completed-toggle" onClick={() => setShowCompleted((v) => !v)}>
                      {showCompleted ? "▾" : "▸"} Fully onboarded <span>{completed.length}</span>
                    </button>
                    {showCompleted && <div className="onb-directory">{completed.map((c) => <ClientCard key={c.id} client={c} />)}</div>}
                  </>
                )}
              </>
            );
          })()}
        </main>
      </section>
    </div>
  );
}
