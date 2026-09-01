// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../../components/AppSidebar";
import Crumb from "../../../components/Crumb";
import GlobalAppearanceControl from "../../../components/GlobalAppearanceControl";
import ProjectBoard, { type BoardTask, type BoardClient, type NewFields } from "../../Board";
import "../../project-management.css";

type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type ViewDef = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; slackChannelId?: string; memberSlugs: string[] };
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();

export default function GroupView() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [view, setView] = useState<ViewDef | null>(null);
  const [members, setMembers] = useState<BoardClient[]>([]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [weekBadge, setWeekBadge] = useState<string | null>(null);

  const load = async () => {
    const [vw, cl] = await Promise.all([
      fetch("/api/project-management/views", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
      fetch("/api/project-management/clients", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    ]);
    const v = (vw.views as ViewDef[] | undefined)?.find((x) => x.slug === slug) ?? null;
    setView(v);
    const clients = (cl.clients as Client[]) || [];
    const mem = v ? v.memberSlugs.map((s) => clients.find((c) => c.slug === s)).filter(Boolean).map((c) => ({ slug: c!.slug, name: c!.name, logoUrl: c!.logoUrl, accentColor: c!.accentColor })) : [];
    setMembers(mem);
    if (v && v.memberSlugs.length) await loadTasks(v.memberSlugs);
    else setLoading(false);
  };
  const loadTasks = async (slugs: string[]) => {
    const p = await fetch(`/api/project-management/tasks?slugs=${encodeURIComponent(slugs.join(","))}`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
    setTasks(Array.isArray(p.tasks) ? p.tasks : []);
    setErr(p.ok ? "" : String(p.error || ""));
    setLoading(false);
  };
  useEffect(() => { if (slug) void load(); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCreate = async (clientSlug: string, fields: NewFields) => {
    const c = members.find((m) => m.slug === clientSlug);
    const tmp: BoardTask = { id: `tmp-${Date.now()}`, title: fields.title, stage: fields.stage, owner: fields.assignee || null, due_date: fields.dueDate || null, context: fields.context || null, links: fields.links || [], priority: fields.priority || null, week: fields.week || null, source: "manual", clientSlug, clientName: c?.name };
    setTasks((p) => [...p, tmp]);
    const r = await fetch("/api/project-management/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: clientSlug, title: fields.title, stage: fields.stage, assignee: fields.assignee, dueDate: fields.dueDate, context: fields.context, links: fields.links, priority: fields.priority, week: fields.week }) }).then((x) => x.json()).catch(() => ({}));
    if (r.ok && r.task) setTasks((p) => p.map((t) => (t.id === tmp.id ? { ...r.task, clientSlug, clientName: c?.name } : t)));
    else if (view) void loadTasks(view.memberSlugs);
  };
  const onUpdate = async (id: string, fields: Record<string, unknown>) => {
    const newClient = fields.moveToSlug ? members.find((m) => m.slug === String(fields.moveToSlug)) : undefined;
    setTasks((p) => p.map((t) => t.id === id ? { ...t, ...(fields.stage ? { stage: String(fields.stage) } : {}), ...(fields.title ? { title: String(fields.title) } : {}), ...("dueDate" in fields ? { due_date: (fields.dueDate as string) || null } : {}), ...("owner" in fields ? { owner: (fields.owner as string) || null } : {}), ...("context" in fields ? { context: (fields.context as string) || null } : {}), ...("priority" in fields ? { priority: (fields.priority as string) || null } : {}), ...("week" in fields ? { week: (fields.week as string) || null } : {}), ...("links" in fields ? { links: Array.isArray(fields.links) ? fields.links as BoardTask["links"] : [] } : {}), ...(newClient ? { clientSlug: newClient.slug, clientName: newClient.name } : {}) } : t));
    await fetch("/api/project-management/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...fields }) }).catch(() => {});
  };
  const onDelete = async (id: string) => { setTasks((p) => p.filter((t) => t.id !== id)); await fetch(`/api/project-management/tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {}); };

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Project management", href: "/project-management" }, { label: view?.name || "View" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="pm-shell pm-board-shell">
          <Link href="/project-management" className="pm-back">← All clients</Link>
          {!loading && !view ? <div className="pm-empty">That view was not found. <Link href="/project-management" style={{ color: "var(--accent)" }}>Back</Link>.</div> : (
            <>
              <div className="pm-client-head">
                <span className="pm-client-logo" style={view?.logoUrl ? undefined : { background: view?.accentColor || "var(--accent)" }}>
                  {view?.logoUrl ? <img src={view.logoUrl} alt="" /> : initials(view?.name || "?")}
                </span>
                <div>
                  <h1>{view?.name || "View"}</h1>
                  <div className="pm-member-bubbles">
                    {members.map((m) => (
                      <Link className="pm-bubble" key={m.slug} title={`${m.name} → project board`} href={`/project-management/${encodeURIComponent(m.slug)}`}>
                        {m.logoUrl ? <img src={m.logoUrl} alt={m.name} /> : <span className="pm-bubble-mono" style={{ background: m.accentColor || "var(--accent)" }}>{initials(m.name)}</span>}
                      </Link>
                    ))}
                  </div>
                </div>
                {weekBadge && <span className="pm-weekbadge">{weekBadge}</span>}
              </div>
              {err && <div className="pm-err">⚠ {err}</div>}
              {loading ? <p className="pm-muted">Loading…</p> : (
                <ProjectBoard tasks={tasks} clients={members} defaultView="table" notifyChannel={view?.slackChannelId || ""} onWeekChange={setWeekBadge} onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} onMove={(id, stage) => void onUpdate(id, { stage })} onSetDay={(id, date) => void onUpdate(id, { dueDate: date })} />
              )}
            </>
          )}
        </main>
      </section>
    </div>
  );
}
