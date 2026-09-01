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
type ViewDef = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; memberSlugs: string[] };
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();

export default function ProjectManagementDirectory() {
  const [clients, setClients] = useState<Client[]>([]);
  const [views, setViews] = useState<ViewDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ViewDef | "new" | null>(null);

  const load = async () => {
    const [cl, vw] = await Promise.all([
      fetch("/api/project-management/clients", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
      fetch("/api/project-management/views", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    ]);
    if (Array.isArray(cl.clients)) setClients(cl.clients);
    if (Array.isArray(vw.views)) setViews(vw.views);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Project management" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="pm-shell pm-directory-shell">
          <div className="pm-dir-head"><h1>Project management</h1><button type="button" className="pm-newview" onClick={() => setEditing("new")}>+ New view</button></div>
          {loading && <p className="pm-muted">Loading…</p>}

          {views.length > 0 && (
            <>
              <div className="pm-dir-label">Views</div>
              <div className="pm-directory">
                {views.map((v) => (
                  <div className="pm-card pm-viewcard" key={v.id}>
                    <Link href={`/project-management/view/${encodeURIComponent(v.slug)}`} className="pm-card-link">
                      <span className="pm-logo" style={v.logoUrl ? undefined : { background: v.accentColor || "var(--accent)" }}>
                        {v.logoUrl ? <img src={v.logoUrl} alt="" /> : initials(v.name)}
                      </span>
                      <span className="pm-card-name">{v.name}</span>
                      <span className="pm-card-sub">{v.memberSlugs.length} client{v.memberSlugs.length === 1 ? "" : "s"}</span>
                    </Link>
                    <button type="button" className="pm-card-edit" title="Edit view" onClick={() => setEditing(v)}>⋯</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && clients.length === 0 && <div className="pm-empty">No clients yet.</div>}
          {clients.length > 0 && <div className="pm-dir-label">Clients</div>}
          <div className="pm-directory">
            {clients.map((c) => (
              <Link href={`/project-management/${encodeURIComponent(c.slug)}`} className="pm-card" key={c.id}>
                <span className="pm-logo" style={c.logoUrl ? undefined : { background: c.accentColor || "var(--accent)" }}>
                  {c.logoUrl ? <img src={c.logoUrl} alt="" /> : initials(c.name)}
                </span>
                <span className="pm-card-name">{c.name}</span>
              </Link>
            ))}
          </div>
        </main>
      </section>

      {editing && <ViewEditor view={editing === "new" ? null : editing} clients={clients} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function ViewEditor({ view, clients, onClose, onSaved }: { view: ViewDef | null; clients: Client[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(view?.name ?? "");
  const [logoUrl, setLogoUrl] = useState(view?.logoUrl ?? "");
  const [members, setMembers] = useState<string[]>(view?.memberSlugs ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toggle = (slug: string) => setMembers((p) => p.includes(slug) ? p.filter((s) => s !== slug) : [...p, slug]);

  const save = async () => {
    if (!name.trim()) { setErr("Give the view a name."); return; }
    if (!members.length) { setErr("Pick at least one client."); return; }
    setBusy(true); setErr("");
    const body = { name: name.trim(), memberSlugs: members, logoUrl: logoUrl.trim() || null, ...(view ? { id: view.id } : {}) };
    const r = await fetch("/api/project-management/views", { method: view ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({}));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(String(r.error || "Could not save."));
  };
  const remove = async () => {
    if (!view || !window.confirm(`Delete the "${view.name}" view? The clients and their projects are not affected.`)) return;
    setBusy(true);
    await fetch(`/api/project-management/views?id=${encodeURIComponent(view.id)}`, { method: "DELETE" }).catch(() => {});
    onSaved();
  };

  return (
    <div className="pm-modal-back" onClick={onClose}>
      <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-modal-head"><h2>{view ? "Edit view" : "New view"}</h2><button type="button" className="pm-modal-x" onClick={onClose}>✕</button></div>
        <div className="pm-modal-body">
          <label className="pm-f"><span>Name</span><input value={name} placeholder="e.g. Healthtech" onChange={(e) => setName(e.target.value)} /></label>
          <label className="pm-f"><span>Logo URL <em style={{ fontWeight: 400, color: "var(--muted-2)" }}>· optional</em></span><input value={logoUrl} placeholder="Paste an image URL" onChange={(e) => setLogoUrl(e.target.value)} /></label>
          <div className="pm-f"><span>Clients in this view</span>
            <div className="pm-member-grid">
              {clients.map((c) => (
                <button type="button" key={c.slug} className={`pm-member ${members.includes(c.slug) ? "on" : ""}`} onClick={() => toggle(c.slug)}>
                  <span className="pm-member-logo" style={c.logoUrl ? undefined : { background: c.accentColor || "var(--accent)" }}>{c.logoUrl ? <img src={c.logoUrl} alt="" /> : initials(c.name)}</span>
                  <span>{c.name}</span>
                  {members.includes(c.slug) && <span className="pm-member-check">✓</span>}
                </button>
              ))}
            </div>
          </div>
          {err && <p className="pm-err" style={{ margin: 0 }}>{err}</p>}
        </div>
        <div className="pm-modal-foot">
          {view ? <button type="button" className="pm-del" onClick={remove}>Delete</button> : <span />}
          <button type="button" className="pm-save" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save view"}</button>
        </div>
      </div>
    </div>
  );
}
