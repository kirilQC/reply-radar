// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import "../project-management.css";

type Task = { id: string; title: string; stage: string; owner: string | null; due_date: string | null; source: string; position: number };
type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type View = "kanban" | "swimlanes" | "list" | "timeline" | "pipeline";

const STAGES: { key: string; label: string; cls: string }[] = [
  { key: "todo", label: "To do", cls: "todo" },
  { key: "in_progress", label: "In progress", cls: "prog" },
  { key: "paused", label: "Paused", cls: "pause" },
  { key: "completed", label: "Completed", cls: "done" },
  { key: "launched", label: "Launched", cls: "launch" },
];
const stageOf = (k: string) => STAGES.find((s) => s.key === k) ?? STAGES[0];
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();
const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
const sourceLabel = (s: string) => (s === "morning_brief" ? "From brief" : s === "call_analysis" ? "From call" : "");

function iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function weekdays(): { key: string; label: string; date: string; today: boolean }[] {
  const now = new Date(); const day = now.getDay(); const mon = new Date(now); mon.setDate(now.getDate() - ((day + 6) % 7));
  const todayStr = iso(now);
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].map((label, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return { key: iso(d), label, date: iso(d), today: iso(d) === todayStr }; });
}

export default function ClientProjects() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<Client | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>("kanban");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<Task | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => { try { const v = localStorage.getItem("pm-view") as View | null; if (v) setView(v); } catch { /* ignore */ } }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem("pm-view", v); } catch { /* ignore */ } };

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

  const addTask = async (title: string, stage: string) => {
    const t = title.trim(); if (!t) return;
    const optimistic: Task = { id: `tmp-${Date.now()}`, title: t, stage, owner: null, due_date: null, source: "manual", position: Date.now() };
    setTasks((prev) => [...prev, optimistic]);
    const p = await fetch("/api/project-management/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, title: t, stage }) }).then((r) => r.json()).catch(() => ({}));
    if (p.ok && p.task) setTasks((prev) => prev.map((x) => (x.id === optimistic.id ? p.task : x)));
    else { setErr(String(p.error || "Could not add task.")); void loadTasks(); }
  };
  const patchTask = async (id: string, fields: Record<string, unknown>) => {
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, ...(fields.stage ? { stage: String(fields.stage) } : {}), ...(("dueDate" in fields) ? { due_date: (fields.dueDate as string) || null } : {}), ...(("owner" in fields) ? { owner: (fields.owner as string) || null } : {}), ...(fields.title ? { title: String(fields.title) } : {}) } : x)));
    await fetch("/api/project-management/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...fields }) }).catch(() => {});
  };
  const removeTask = async (id: string) => {
    setTasks((prev) => prev.filter((x) => x.id !== id)); setEditing(null);
    await fetch(`/api/project-management/tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  };

  const onDropStage = (stage: string) => { if (dragId) { void patchTask(dragId, { stage }); setDragId(null); } };
  const onDropDay = (date: string) => { if (dragId) { void patchTask(dragId, { dueDate: date }); setDragId(null); } };

  const byStage = useMemo(() => { const m: Record<string, Task[]> = {}; for (const s of STAGES) m[s.key] = []; for (const t of tasks) (m[t.stage] || m.todo).push(t); return m; }, [tasks]);

  const views: [View, string][] = [["kanban", "Kanban"], ["swimlanes", "Swimlanes"], ["list", "List"], ["timeline", "Week"], ["pipeline", "Pipeline"]];

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
          <div className="pm-board-head">
            <div className="pm-client-head" style={{ margin: 0, padding: 0, border: 0 }}>
              <span className="pm-client-logo" style={client?.logoUrl ? undefined : { background: client?.accentColor || "var(--accent)" }}>
                {client?.logoUrl ? <img src={client.logoUrl} alt="" /> : (client?.name?.[0] || "?").toUpperCase()}
              </span>
              <h1>{client?.name || "Client"}</h1>
            </div>
            <div className="pm-viewswitch">
              {views.map(([v, label]) => <button key={v} type="button" className={view === v ? "on" : ""} onClick={() => pickView(v)}>{label}</button>)}
            </div>
          </div>

          {err && <div className="pm-err">⚠ {err}</div>}
          {loading ? <p className="pm-muted">Loading…</p> : (
            <>
              {view === "kanban" && <KanbanView byStage={byStage} onAdd={addTask} onDropStage={onDropStage} onDrag={setDragId} onOpen={setEditing} />}
              {view === "swimlanes" && <SwimlanesView tasks={tasks} onDrop={(id, stage) => void patchTask(id, { stage })} onDrag={setDragId} dragId={dragId} onOpen={setEditing} />}
              {view === "list" && <ListView byStage={byStage} onAdd={addTask} onDropStage={onDropStage} onDrag={setDragId} onOpen={setEditing} />}
              {view === "timeline" && <TimelineView tasks={tasks} onDropDay={onDropDay} onDrag={setDragId} onOpen={setEditing} onAdd={addTask} />}
              {view === "pipeline" && <PipelineView tasks={tasks} onSetStage={(id, stage) => void patchTask(id, { stage })} onOpen={setEditing} onAdd={addTask} />}
            </>
          )}
        </main>
      </section>

      {editing && <TaskEditor task={editing} onClose={() => setEditing(null)} onSave={(f) => { void patchTask(editing.id, f); setEditing(null); }} onDelete={() => void removeTask(editing.id)} />}
    </div>
  );
}

/* ── shared card ── */
function Card({ t, onDrag, onOpen, compact }: { t: Task; onDrag: (id: string | null) => void; onOpen: (t: Task) => void; compact?: boolean }) {
  return (
    <div className={`pm-card2 ${compact ? "compact" : ""}`} draggable onDragStart={(e) => { e.dataTransfer.setData("id", t.id); onDrag(t.id); }} onDragEnd={() => onDrag(null)} onClick={() => onOpen(t)}>
      <div className="pm-c-title">{t.source !== "manual" && <span className="pm-auto" title={sourceLabel(t.source)}>✦</span>}{t.title}</div>
      {!compact && (
        <div className="pm-c-meta">
          {t.owner ? <span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span> : <span className="pm-av pm-av-none">?</span>}
          {t.due_date && <span className="pm-due">{new Date(t.due_date + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
          {t.source !== "manual" && <span className="pm-src">{sourceLabel(t.source)}</span>}
        </div>
      )}
    </div>
  );
}

/* ── quick add ── */
function QuickAdd({ stage, onAdd }: { stage: string; onAdd: (title: string, stage: string) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  const submit = () => { if (v.trim()) { onAdd(v, stage); setV(""); } };
  if (!open) return <button type="button" className="pm-add" onClick={() => setOpen(true)}>+ Add</button>;
  return <input className="pm-add-input" autoFocus value={v} placeholder="Task title…" onChange={(e) => setV(e.target.value)}
    onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { setOpen(false); setV(""); } }}
    onBlur={() => { submit(); setOpen(false); }} />;
}

/* ── 1 Kanban ── */
function KanbanView({ byStage, onAdd, onDropStage, onDrag, onOpen }: { byStage: Record<string, Task[]>; onAdd: (t: string, s: string) => void; onDropStage: (s: string) => void; onDrag: (id: string | null) => void; onOpen: (t: Task) => void }) {
  return (
    <div className="pm-kb">
      {STAGES.map((s) => (
        <div className="pm-col" key={s.key} onDragOver={(e) => e.preventDefault()} onDrop={() => onDropStage(s.key)}>
          <div className="pm-colh"><span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span><span className="pm-n">{byStage[s.key].length}</span></div>
          {byStage[s.key].map((t) => <Card key={t.id} t={t} onDrag={onDrag} onOpen={onOpen} />)}
          <QuickAdd stage={s.key} onAdd={onAdd} />
        </div>
      ))}
    </div>
  );
}

/* ── 2 Swimlanes (owner × stage) ── */
function SwimlanesView({ tasks, onDrop, onDrag, dragId, onOpen }: { tasks: Task[]; onDrop: (id: string, s: string) => void; onDrag: (id: string | null) => void; dragId: string | null; onOpen: (t: Task) => void }) {
  const owners = useMemo(() => { const set = new Set<string>(); for (const t of tasks) set.add(t.owner || "Unassigned"); return Array.from(set).sort(); }, [tasks]);
  const cols = [{ key: "todo", label: "To do" }, { key: "in_progress", label: "In progress" }, { key: "done", label: "Done / Launched" }];
  const inCol = (t: Task, col: string) => col === "done" ? (t.stage === "completed" || t.stage === "launched") : col === "todo" ? (t.stage === "todo" || t.stage === "paused") : t.stage === "in_progress";
  const dropStage = (col: string) => col === "done" ? "completed" : col === "todo" ? "todo" : "in_progress";
  return (
    <div className="pm-sw" style={{ gridTemplateColumns: `130px repeat(${cols.length}, 1fr)` }}>
      <div className="pm-swch">Owner</div>
      {cols.map((c) => <div className="pm-swch" key={c.key}>{c.label}</div>)}
      {owners.map((owner) => (
        <div className="pm-swrow" key={owner} style={{ display: "contents" }}>
          <div className="pm-swwho"><span className="pm-av" style={{ background: owner === "Unassigned" ? "var(--muted-2,#555)" : `hsl(${hue(owner)} 55% 45%)` }}>{initials(owner)}</span>{owner}</div>
          {cols.map((c) => (
            <div className="pm-swcell" key={c.key} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragId) onDrop(dragId, dropStage(c.key)); }}>
              {tasks.filter((t) => (t.owner || "Unassigned") === owner && inCol(t, c.key)).map((t) => <Card key={t.id} t={t} onDrag={onDrag} onOpen={onOpen} compact />)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── 3 Grouped list ── */
function ListView({ byStage, onAdd, onDropStage, onDrag, onOpen }: { byStage: Record<string, Task[]>; onAdd: (t: string, s: string) => void; onDropStage: (s: string) => void; onDrag: (id: string | null) => void; onOpen: (t: Task) => void }) {
  return (
    <div className="pm-list">
      {STAGES.map((s) => (
        <div className="pm-lgrp" key={s.key} onDragOver={(e) => e.preventDefault()} onDrop={() => onDropStage(s.key)}>
          <div className="pm-lgh"><span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span><span className="pm-n">{byStage[s.key].length}</span><span className="pm-lgh-add"><QuickAdd stage={s.key} onAdd={onAdd} /></span></div>
          {byStage[s.key].map((t) => (
            <div className="pm-lrow" key={t.id} draggable onDragStart={(e) => { e.dataTransfer.setData("id", t.id); onDrag(t.id); }} onDragEnd={() => onDrag(null)} onClick={() => onOpen(t)}>
              <span className="pm-grip">⠿</span>
              {t.owner ? <span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span> : <span className="pm-av pm-av-none">?</span>}
              <span className="pm-lt">{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</span>
              {t.due_date && <span className="pm-due">{new Date(t.due_date + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
            </div>
          ))}
          {byStage[s.key].length === 0 && <div className="pm-lempty">Drop a task here</div>}
        </div>
      ))}
    </div>
  );
}

/* ── 4 Week timeline ── */
function TimelineView({ tasks, onDropDay, onDrag, onOpen, onAdd }: { tasks: Task[]; onDropDay: (d: string) => void; onDrag: (id: string | null) => void; onOpen: (t: Task) => void; onAdd: (t: string, s: string) => void }) {
  const days = weekdays();
  const unscheduled = tasks.filter((t) => !t.due_date || !days.some((d) => d.date === t.due_date));
  return (
    <div className="pm-tl">
      <div className="pm-day pm-unsched" onDragOver={(e) => e.preventDefault()} onDrop={() => onDropDay("")}>
        <div className="pm-dayh">Unscheduled <span>{unscheduled.length}</span></div>
        {unscheduled.map((t) => <Card key={t.id} t={t} onDrag={onDrag} onOpen={onOpen} compact />)}
        <QuickAdd stage="todo" onAdd={onAdd} />
      </div>
      {days.map((d) => {
        const dayTasks = tasks.filter((t) => t.due_date === d.date);
        return (
          <div className={`pm-day ${d.today ? "today" : ""}`} key={d.key} onDragOver={(e) => e.preventDefault()} onDrop={() => onDropDay(d.date)}>
            <div className="pm-dayh">{d.label}{d.today ? " · today" : ""} <span>{dayTasks.length}</span></div>
            {dayTasks.map((t) => <Card key={t.id} t={t} onDrag={onDrag} onOpen={onOpen} compact />)}
          </div>
        );
      })}
    </div>
  );
}

/* ── 5 Pipeline rows ── */
function PipelineView({ tasks, onSetStage, onOpen, onAdd }: { tasks: Task[]; onSetStage: (id: string, s: string) => void; onOpen: (t: Task) => void; onAdd: (t: string, s: string) => void }) {
  const [adding, setAdding] = useState("");
  return (
    <div className="pm-pipe">
      {tasks.map((t) => {
        const idx = STAGES.findIndex((s) => s.key === t.stage);
        return (
          <div className="pm-prow" key={t.id}>
            <span className="pm-pt" onClick={() => onOpen(t)}>{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</span>
            <div className="pm-track">
              {STAGES.map((s, i) => (
                <button type="button" key={s.key} className={`pm-seg ${i <= idx ? `on ${s.cls}` : ""}`} title={`Move to ${s.label}`} onClick={() => onSetStage(t.id, s.key)}>{s.label}</button>
              ))}
            </div>
            {t.owner ? <span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span> : <span className="pm-av pm-av-none">?</span>}
          </div>
        );
      })}
      <div className="pm-prow pm-prow-add">
        <input className="pm-add-input" value={adding} placeholder="+ Add a project…" onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && adding.trim()) { onAdd(adding, "todo"); setAdding(""); } }} />
      </div>
    </div>
  );
}

/* ── task editor ── */
function TaskEditor({ task, onClose, onSave, onDelete }: { task: Task; onClose: () => void; onSave: (f: Record<string, unknown>) => void; onDelete: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [owner, setOwner] = useState(task.owner || "");
  const [due, setDue] = useState(task.due_date || "");
  const [stage, setStage] = useState(task.stage);
  return (
    <div className="pm-modal-back" onClick={onClose}>
      <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-modal-head"><h2>Edit task</h2><button type="button" className="pm-modal-x" onClick={onClose}>✕</button></div>
        <div className="pm-modal-body">
          <label className="pm-f"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <div className="pm-f-row">
            <label className="pm-f"><span>Owner</span><input value={owner} placeholder="Name" onChange={(e) => setOwner(e.target.value)} /></label>
            <label className="pm-f"><span>Due date</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          </div>
          <label className="pm-f"><span>Stage</span>
            <select value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
          </label>
          {task.source !== "manual" && <p className="pm-src-note">✦ Auto-added {sourceLabel(task.source).toLowerCase()}.</p>}
        </div>
        <div className="pm-modal-foot">
          <button type="button" className="pm-del" onClick={onDelete}>Delete</button>
          <button type="button" className="pm-save" onClick={() => onSave({ title, owner, dueDate: due, stage })}>Save</button>
        </div>
      </div>
    </div>
  );
}
