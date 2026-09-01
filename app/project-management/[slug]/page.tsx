// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import ProjectBoard, { type BoardTask } from "../Board";
import "../project-management.css";

type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();

export default function ClientProjects() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<Client | null>(null);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const loadClient = async () => {
    const p = await fetch("/api/project-management/clients", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
    setClient((p.clients as Client[] | undefined)?.find((c) => c.slug === slug) ?? null);
  };
  const loadTasks = async () => {
    const p = await fetch(`/api/project-management/tasks?slug=${encodeURIComponent(slug)}`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
    setTasks(Array.isArray(p.tasks) ? p.tasks : []);
    setErr(p.ok ? "" : String(p.error || ""));
    setLoading(false);
  };
  useEffect(() => { if (slug) { void loadClient(); void loadTasks(); } }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCreate = async (clientSlug: string, fields: { title: string; stage: string }) => {
    const tmp: BoardTask = { id: `tmp-${Date.now()}`, title: fields.title, stage: fields.stage, owner: null, due_date: null, source: "manual", clientSlug, clientName: client?.name };
    setTasks((p) => [...p, tmp]);
    const r = await fetch("/api/project-management/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: clientSlug, title: fields.title, stage: fields.stage }) }).then((x) => x.json()).catch(() => ({}));
    if (r.ok && r.task) setTasks((p) => p.map((t) => (t.id === tmp.id ? { ...r.task, clientSlug, clientName: client?.name } : t)));
    else void loadTasks();
  };
  const onUpdate = async (id: string, fields: Record<string, unknown>) => {
    setTasks((p) => p.map((t) => t.id === id ? { ...t, ...(fields.stage ? { stage: String(fields.stage) } : {}), ...(fields.title ? { title: String(fields.title) } : {}), ...("dueDate" in fields ? { due_date: (fields.dueDate as string) || null } : {}), ...("owner" in fields ? { owner: (fields.owner as string) || null } : {}), ...("context" in fields ? { context: (fields.context as string) || null } : {}), ...("links" in fields ? { links: Array.isArray(fields.links) ? fields.links as string[] : [] } : {}) } : t));
    await fetch("/api/project-management/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...fields }) }).catch(() => {});
  };
  const onDelete = async (id: string) => { setTasks((p) => p.filter((t) => t.id !== id)); await fetch(`/api/project-management/tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {}); };

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Project management", href: "/project-management" }, { label: client?.name || "Client" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="pm-shell pm-board-shell">
          <Link href="/project-management" className="pm-back">← All clients</Link>
          <div className="pm-client-head">
            <span className="pm-client-logo" style={client?.logoUrl ? undefined : { background: client?.accentColor || "var(--accent)" }}>
              {client?.logoUrl ? <img src={client.logoUrl} alt="" /> : initials(client?.name || "?")}
            </span>
            <h1>{client?.name || "Client"}</h1>
          </div>
          {err && <div className="pm-err">⚠ {err}</div>}
          {loading ? <p className="pm-muted">Loading…</p> : (
            <ProjectBoard tasks={tasks} clients={client ? [client] : []} onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} onMove={(id, stage) => void onUpdate(id, { stage })} onSetDay={(id, date) => void onUpdate(id, { dueDate: date })} />
          )}
        </main>
      </section>
    </div>
  );
}
