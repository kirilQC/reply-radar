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

type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; slackChannelId?: string };
type ViewDef = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; memberSlugs: string[] };
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();
const slackIcon = (
  <svg width="12" height="12" viewBox="0 0 127 127" aria-hidden style={{ flex: "none" }}><path d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80z" fill="#E01E5A" /><path d="M33.8 80c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z" fill="#E01E5A" /><path d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47z" fill="#36C5F0" /><path d="M47 33.6c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H14C6.7 60 .8 54.1.8 46.8c0-7.3 5.9-13.2 13.2-13.2h33z" fill="#36C5F0" /><path d="M99.8 46.8c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.8V46.8z" fill="#2EB67D" /><path d="M93.2 46.8c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2v-33C66.8 6.5 72.7.6 80 .6c7.3 0 13.2 5.9 13.2 13.2v33z" fill="#2EB67D" /><path d="M80 99.6c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.6H80z" fill="#ECB22E" /><path d="M80 93c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80z" fill="#ECB22E" /></svg>
);

export default function ProjectManagementDirectory() {
  const [clients, setClients] = useState<Client[]>([]);
  const [views, setViews] = useState<ViewDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ViewDef | "new" | null>(null);
  const [editingClient, setEditingClient] = useState<Client | null>(null);

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
              <div className="pm-directory pm-directory-views">
                {views.map((v) => (
                  <div className="pm-card pm-viewcard" key={v.id}>
                    <Link href={`/project-management/view/${encodeURIComponent(v.slug)}`} className="pm-card-link">
                      <span className="pm-logo" style={v.logoUrl ? undefined : { background: v.accentColor || "var(--accent)" }}>
                        {v.logoUrl ? <img src={v.logoUrl} alt="" /> : initials(v.name)}
                      </span>
                      <span className="pm-card-name">{v.name}</span>
                      <span className="pm-card-members">
                        {v.memberSlugs.slice(0, 6).map((s) => { const c = clients.find((x) => x.slug === s); if (!c) return null; return (
                          <span className="pm-vbubble" key={s} title={c.name}>{c.logoUrl ? <img src={c.logoUrl} alt="" /> : <span className="pm-vbubble-mono" style={{ background: c.accentColor || "var(--accent)" }}>{initials(c.name)}</span>}</span>
                        ); })}
                        {v.memberSlugs.length > 6 && <span className="pm-vbubble pm-vbubble-more">+{v.memberSlugs.length - 6}</span>}
                      </span>
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
              <div className="pm-card pm-viewcard" key={c.id}>
                <Link href={`/project-management/${encodeURIComponent(c.slug)}`} className="pm-card-link">
                  <span className="pm-logo" style={c.logoUrl ? undefined : { background: c.accentColor || "var(--accent)" }}>
                    {c.logoUrl ? <img src={c.logoUrl} alt="" /> : initials(c.name)}
                  </span>
                  <span className="pm-card-name">{c.name}</span>
                  <span className="pm-card-slackline">{slackIcon}{c.slackChannelId ? "Slack channel set" : "No Slack channel"}</span>
                </Link>
                <button type="button" className="pm-card-edit" title="Set internal Slack channel" onClick={() => setEditingClient(c)}>⋯</button>
              </div>
            ))}
          </div>
        </main>
      </section>

      {editing && <ViewEditor view={editing === "new" ? null : editing} clients={clients} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {editingClient && <ClientEditor client={editingClient} onClose={() => setEditingClient(null)} onSaved={() => { setEditingClient(null); void load(); }} />}
    </div>
  );
}

function ClientEditor({ client, onClose, onSaved }: { client: Client; onClose: () => void; onSaved: () => void }) {
  const [channel, setChannel] = useState(client.slackChannelId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true); setErr("");
    const r = await fetch("/api/project-management/clients", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: client.slug, slackChannelId: channel.trim() }) }).then((x) => x.json()).catch(() => ({}));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(String(r.error || "Could not save."));
  };
  return (
    <div className="pm-modal-back" onClick={onClose}>
      <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-modal-head"><h2>{client.name} · Slack</h2><button type="button" className="pm-modal-x" onClick={onClose}>✕</button></div>
        <div className="pm-modal-body">
          <label className="pm-f"><span>Internal Slack channel ID</span><input value={channel} placeholder="e.g. C0123ABCD" onChange={(e) => setChannel(e.target.value)} /></label>
          <p className="pm-muted" style={{ margin: 0, lineHeight: 1.6 }}>This is where the per-task <b>Send to Slack</b> button posts a project&apos;s status. Most clients are already filled in from Reply Radar. To find an ID: open the channel in Slack → channel name → About → the ID is at the bottom (starts with C).</p>
          {err && <p className="pm-err" style={{ margin: 0 }}>{err}</p>}
        </div>
        <div className="pm-modal-foot"><span /><button type="button" className="pm-save" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button></div>
      </div>
    </div>
  );
}

function ViewEditor({ view, clients, onClose, onSaved }: { view: ViewDef | null; clients: Client[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(view?.name ?? "");
  const [logoUrl, setLogoUrl] = useState(view?.logoUrl ?? "");
  const [members, setMembers] = useState<string[]>(view?.memberSlugs ?? []);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const toggle = (slug: string) => setMembers((p) => p.includes(slug) ? p.filter((s) => s !== slug) : [...p, slug]);
  const uploadLogo = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    const fd = new FormData(); fd.append("file", file);
    const r = await fetch("/api/project-management/upload-logo", { method: "POST", body: fd }).then((x) => x.json()).catch(() => ({}));
    setUploading(false);
    if (r.ok && r.logoUrl) setLogoUrl(r.logoUrl); else setErr(String(r.error || "Upload failed."));
  };

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
          <div className="pm-f"><span>Logo <em style={{ fontWeight: 400, color: "var(--muted-2)" }}>· optional</em></span>
            <div className="pm-logo-row">
              <span className="pm-logo-prev" style={logoUrl ? undefined : { background: "var(--accent)" }}>{logoUrl ? <img src={logoUrl} alt="" /> : initials(name || "?")}</span>
              <label className="pm-logo-upload">{uploading ? "Uploading…" : "Upload image"}<input type="file" accept="image/*" hidden onChange={(e) => void uploadLogo(e.target.files?.[0] ?? undefined)} /></label>
              <input className="pm-logo-urlin" value={logoUrl} placeholder="or paste an image URL" onChange={(e) => setLogoUrl(e.target.value)} />
            </div>
          </div>
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
