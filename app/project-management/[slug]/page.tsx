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
import ProjectBoard, { type BoardTask, type NewFields } from "../Board";
import "../project-management.css";
import Skeleton from "../../components/Skeleton";

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

  const onCreate = async (clientSlug: string, fields: NewFields) => {
    const tmp: BoardTask = { id: `tmp-${Date.now()}`, title: fields.title, stage: fields.stage, owner: fields.assignee || null, due_date: fields.dueDate || null, context: fields.context || null, links: fields.links || [], priority: fields.priority || null, week: fields.week || null, checks: fields.checks ?? null, source: "manual", clientSlug, clientName: client?.name };
    setTasks((p) => [...p, tmp]);
    const r = await fetch("/api/project-management/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: clientSlug, title: fields.title, stage: fields.stage, assignee: fields.assignee, dueDate: fields.dueDate, context: fields.context, links: fields.links, priority: fields.priority, week: fields.week, checks: fields.checks }) }).then((x) => x.json()).catch(() => ({}));
    if (r.ok && r.task) setTasks((p) => p.map((t) => (t.id === tmp.id ? { ...r.task, clientSlug, clientName: client?.name } : t)));
    else void loadTasks();
  };
  const onUpdate = async (id: string, fields: Record<string, unknown>) => {
    const me = (() => { try { return localStorage.getItem("pm-me") || ""; } catch { return ""; } })();
    const stamp = { updated_at: new Date().toISOString(), updated_by: me || null };
    setTasks((p) => p.map((t) => t.id === id ? { ...t, ...stamp, ...(fields.stage ? { stage: String(fields.stage) } : {}), ...(fields.title ? { title: String(fields.title) } : {}), ...("dueDate" in fields ? { due_date: (fields.dueDate as string) || null } : {}), ...("owner" in fields ? { owner: (fields.owner as string) || null } : {}), ...("context" in fields ? { context: (fields.context as string) || null } : {}), ...("priority" in fields ? { priority: (fields.priority as string) || null } : {}), ...("week" in fields ? { week: (fields.week as string) || null } : {}), ...("checks" in fields ? { checks: fields.checks as BoardTask["checks"] } : {}), ...("blocker" in fields ? { blocker: fields.blocker as BoardTask["blocker"] } : {}), ...("links" in fields ? { links: Array.isArray(fields.links) ? fields.links as BoardTask["links"] : [] } : {}) } : t));
    await fetch("/api/project-management/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...fields, updatedBy: me || undefined }) }).catch(() => {});
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
            {!client && loading ? <span className="pm-client-logo rr-skel"><span className="rr-skel-bar" style={{ width: "100%", height: "100%", borderRadius: "inherit" }} /></span> : (
            <span className="pm-client-logo" style={client?.logoUrl ? undefined : { background: client?.accentColor || "var(--accent)" }}>
              {client?.logoUrl ? <img src={client.logoUrl} alt="" /> : initials(client?.name || "?")}
            </span>
            )}
            {!client && loading ? <h1 className="rr-skel" aria-label="Loading"><span className="rr-skel-bar" style={{ width: 220, height: 34, borderRadius: 8 }} /></h1> : <h1 className="rr-appear">{client?.name || "Client"}</h1>}
          </div>
          {err && <div className="pm-err">⚠ {err}</div>}
          {loading ? <Skeleton variant="board" label="Loading tasks" /> : (
            <div className="rr-appear"><ProjectBoard tasks={tasks} clients={client ? [client] : []} onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} onMove={(id, stage) => void onUpdate(id, { stage })} onSetDay={(id, date) => void onUpdate(id, { dueDate: date })} /></div>
          )}
        </main>
      </section>
    </div>
  );
}
