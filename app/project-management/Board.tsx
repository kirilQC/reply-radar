// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";

export type BoardTask = { id: string; title: string; stage: string; owner: string | null; due_date: string | null; context?: string | null; links?: string[]; source: string; clientSlug?: string; clientName?: string };
export type BoardClient = { slug: string; name: string; logoUrl?: string | null; accentColor?: string | null };
type View = "kanban" | "swimlanes" | "list" | "timeline" | "pipeline";

const STAGES: { key: string; label: string; cls: string }[] = [
  { key: "todo", label: "To do", cls: "todo" },
  { key: "in_progress", label: "In progress", cls: "prog" },
  { key: "paused", label: "Paused", cls: "pause" },
  { key: "completed", label: "Completed", cls: "done" },
  { key: "launched", label: "Launched", cls: "launch" },
];
const scoreClass = (s: string) => STAGES.find((x) => x.key === s)?.cls ?? "todo";
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();
const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
const sourceLabel = (s: string) => (s === "morning_brief" ? "From brief" : s === "call_analysis" ? "From call" : "");
const linkLabel = (u: string) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, ""); } catch { return u; } };
const fmtDT = (v?: string) => { if (!v) return "—"; const d = new Date(v); return Number.isNaN(+d) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) + ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); };
function iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function weekdays() { const now = new Date(); const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); const t = iso(now); return ["Mon", "Tue", "Wed", "Thu", "Fri"].map((label, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return { label, date: iso(d), today: iso(d) === t }; }); }

type Handlers = {
  clients: BoardClient[];
  multi: boolean;
  onCreate: (clientSlug: string, fields: { title: string; stage: string }) => void;
  onOpen: (t: BoardTask) => void;
  onDrag: (id: string | null) => void;
  dragId: string | null;
  onMove: (id: string, stage: string) => void;
  onSetDay: (id: string, date: string) => void;
};

function ClientChip({ t, clients }: { t: BoardTask; clients: BoardClient[] }) {
  const c = clients.find((x) => x.slug === t.clientSlug);
  if (!c) return null;
  return <span className="pm-cchip">{c.logoUrl ? <img src={c.logoUrl} alt="" /> : <span className="pm-cchip-mono" style={{ background: c.accentColor || "var(--accent)" }}>{initials(c.name)}</span>}{c.name}</span>;
}

function Card({ t, h }: { t: BoardTask; h: Handlers }) {
  return (
    <div className="pm-card2" draggable onDragStart={(e) => { e.dataTransfer.setData("id", t.id); h.onDrag(t.id); }} onDragEnd={() => h.onDrag(null)} onClick={() => h.onOpen(t)}>
      <div className="pm-c-title">{t.source !== "manual" && <span className="pm-auto" title={sourceLabel(t.source)}>✦</span>}{t.title}</div>
      <div className="pm-c-meta">
        {h.multi && <ClientChip t={t} clients={h.clients} />}
        {t.owner ? <span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span> : null}
        {t.due_date && <span className="pm-due">{new Date(t.due_date + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
        {Array.isArray(t.links) && t.links.length > 0 && <span className="pm-clip">🔗 {t.links.length}</span>}
      </div>
    </div>
  );
}

/** Add row — a client picker (in a group view) + title, or just a title for a single client. */
function AddTask({ stage, h }: { stage: string; h: Handlers }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState(h.clients[0]?.slug ?? "");
  const submit = () => { const c = h.multi ? slug : h.clients[0]?.slug; if (title.trim() && c) { h.onCreate(c, { title, stage }); setTitle(""); } };
  if (!open) return <button type="button" className="pm-add" onClick={() => setOpen(true)}>+ Add</button>;
  return (
    <div className="pm-addbox">
      {h.multi && (
        <select className="pm-add-client" value={slug} onChange={(e) => setSlug(e.target.value)}>
          {h.clients.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </select>
      )}
      <input className="pm-add-input" autoFocus value={title} placeholder="Task title…" onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { setOpen(false); setTitle(""); } }} />
      <div className="pm-add-actions"><button type="button" className="pm-add-go" onClick={submit}>Add</button><button type="button" className="pm-add-x" onClick={() => { setOpen(false); setTitle(""); }}>Cancel</button></div>
    </div>
  );
}

function KanbanView({ byStage, h }: { byStage: Record<string, BoardTask[]>; h: Handlers }) {
  return (
    <div className="pm-kb">
      {STAGES.map((s) => (
        <div className="pm-col" key={s.key} onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onMove(h.dragId, s.key)}>
          <div className="pm-colh"><span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span><span className="pm-n">{byStage[s.key].length}</span></div>
          {byStage[s.key].map((t) => <Card key={t.id} t={t} h={h} />)}
          <AddTask stage={s.key} h={h} />
        </div>
      ))}
    </div>
  );
}

function SwimlanesView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  const owners = useMemo(() => Array.from(new Set(tasks.map((t) => t.owner || "Unassigned"))).sort(), [tasks]);
  const cols = [{ key: "todo", label: "To do" }, { key: "in_progress", label: "In progress" }, { key: "done", label: "Done / Launched" }];
  const inCol = (t: BoardTask, col: string) => col === "done" ? (t.stage === "completed" || t.stage === "launched") : col === "todo" ? (t.stage === "todo" || t.stage === "paused") : t.stage === "in_progress";
  const dropStage = (col: string) => col === "done" ? "completed" : col === "todo" ? "todo" : "in_progress";
  return (
    <div className="pm-sw" style={{ gridTemplateColumns: `130px repeat(${cols.length}, 1fr)` }}>
      <div className="pm-swch">Owner</div>
      {cols.map((c) => <div className="pm-swch" key={c.key}>{c.label}</div>)}
      {owners.map((owner) => (
        <div key={owner} style={{ display: "contents" }}>
          <div className="pm-swwho"><span className="pm-av" style={{ background: owner === "Unassigned" ? "var(--muted-2,#555)" : `hsl(${hue(owner)} 55% 45%)` }}>{initials(owner)}</span>{owner}</div>
          {cols.map((c) => (
            <div className="pm-swcell" key={c.key} onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onMove(h.dragId, dropStage(c.key))}>
              {tasks.filter((t) => (t.owner || "Unassigned") === owner && inCol(t, c.key)).map((t) => <Card key={t.id} t={t} h={h} />)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ListView({ byStage, h }: { byStage: Record<string, BoardTask[]>; h: Handlers }) {
  return (
    <div className="pm-list">
      {STAGES.map((s) => (
        <div className="pm-lgrp" key={s.key} onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onMove(h.dragId, s.key)}>
          <div className="pm-lgh"><span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span><span className="pm-n">{byStage[s.key].length}</span><span className="pm-lgh-add"><AddTask stage={s.key} h={h} /></span></div>
          {byStage[s.key].map((t) => (
            <div className="pm-lrow" key={t.id} draggable onDragStart={(e) => { e.dataTransfer.setData("id", t.id); h.onDrag(t.id); }} onDragEnd={() => h.onDrag(null)} onClick={() => h.onOpen(t)}>
              <span className="pm-grip">⠿</span>
              {t.owner ? <span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span> : <span className="pm-av pm-av-none">?</span>}
              <span className="pm-lt">{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</span>
              {h.multi && <ClientChip t={t} clients={h.clients} />}
              {t.due_date && <span className="pm-due">{new Date(t.due_date + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
            </div>
          ))}
          {byStage[s.key].length === 0 && <div className="pm-lempty">Drop a task here</div>}
        </div>
      ))}
    </div>
  );
}

function TimelineView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  const days = weekdays();
  const unsched = tasks.filter((t) => !t.due_date || !days.some((d) => d.date === t.due_date));
  return (
    <div className="pm-tl">
      <div className="pm-day pm-unsched" onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onSetDay(h.dragId, "")}>
        <div className="pm-dayh">Unscheduled <span>{unsched.length}</span></div>
        {unsched.map((t) => <Card key={t.id} t={t} h={h} />)}
        <AddTask stage="todo" h={h} />
      </div>
      {days.map((d) => {
        const dayTasks = tasks.filter((t) => t.due_date === d.date);
        return (
          <div className={`pm-day ${d.today ? "today" : ""}`} key={d.date} onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onSetDay(h.dragId, d.date)}>
            <div className="pm-dayh">{d.label}{d.today ? " · today" : ""} <span>{dayTasks.length}</span></div>
            {dayTasks.map((t) => <Card key={t.id} t={t} h={h} />)}
          </div>
        );
      })}
    </div>
  );
}

function PipelineView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  return (
    <div className="pm-pipe">
      {tasks.map((t) => {
        const idx = STAGES.findIndex((s) => s.key === t.stage);
        return (
          <div className="pm-prow" key={t.id}>
            <span className="pm-pt" onClick={() => h.onOpen(t)}>{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}{h.multi && <ClientChip t={t} clients={h.clients} />}</span>
            <div className="pm-track">
              {STAGES.map((s, i) => <button type="button" key={s.key} className={`pm-seg ${i <= idx ? `on ${s.cls}` : ""}`} title={`Move to ${s.label}`} onClick={() => h.onMove(t.id, s.key)}>{s.label}</button>)}
            </div>
            {t.owner ? <span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span> : <span className="pm-av pm-av-none">?</span>}
          </div>
        );
      })}
      <div className="pm-prow pm-prow-add"><AddTask stage="todo" h={h} /></div>
    </div>
  );
}

function TaskEditor({ task, clientName, onClose, onSave, onDelete }: { task: BoardTask; clientName?: string; onClose: () => void; onSave: (f: Record<string, unknown>) => void; onDelete: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [owner, setOwner] = useState(task.owner || "");
  const [due, setDue] = useState(task.due_date || "");
  const [stage, setStage] = useState(task.stage);
  const [context, setContext] = useState(task.context || "");
  const [links, setLinks] = useState<string[]>(Array.isArray(task.links) ? task.links : []);
  const [newLink, setNewLink] = useState("");
  const addLink = () => { const u = newLink.trim(); if (!u) return; setLinks((p) => [...p, /^https?:\/\//i.test(u) ? u : `https://${u}`]); setNewLink(""); };
  return (
    <div className="pm-modal-back" onClick={onClose}>
      <div className="pm-modal pm-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="pm-modal-head"><h2>Task details{clientName ? ` · ${clientName}` : ""}</h2><button type="button" className="pm-modal-x" onClick={onClose}>✕</button></div>
        <div className="pm-modal-body">
          <label className="pm-f"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <div className="pm-f-row">
            <label className="pm-f"><span>Assignee</span><input value={owner} placeholder="Name" onChange={(e) => setOwner(e.target.value)} /></label>
            <label className="pm-f"><span>Due date</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
            <label className="pm-f"><span>Stage</span><select value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          </div>
          <label className="pm-f"><span>Context / notes</span><textarea rows={3} value={context} onChange={(e) => setContext(e.target.value)} /></label>
          <div className="pm-f"><span>Links &amp; files</span><div className="pm-links">
            {links.map((u, i) => <div className="pm-link" key={i}><a href={u} target="_blank" rel="noreferrer">{linkLabel(u)}</a><button type="button" onClick={() => setLinks((p) => p.filter((_, j) => j !== i))}>✕</button></div>)}
            <div className="pm-link-add"><input value={newLink} placeholder="Paste a URL…" onChange={(e) => setNewLink(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} /><button type="button" onClick={addLink}>Add</button></div>
          </div></div>
          <div className="pm-meta-row">{task.source !== "manual" && <span className="pm-src-note">✦ Auto-added {sourceLabel(task.source).toLowerCase()}</span>}</div>
        </div>
        <div className="pm-modal-foot"><button type="button" className="pm-del" onClick={onDelete}>Delete</button><button type="button" className="pm-save" onClick={() => onSave({ title, owner, dueDate: due, stage, context, links })}>Save</button></div>
      </div>
    </div>
  );
}

export default function ProjectBoard({ tasks, clients, onCreate, onUpdate, onDelete, onMove, onSetDay }: {
  tasks: BoardTask[]; clients: BoardClient[];
  onCreate: (clientSlug: string, fields: { title: string; stage: string }) => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, stage: string) => void;
  onSetDay: (id: string, date: string) => void;
}) {
  const [view, setView] = useState<View>("kanban");
  const [editing, setEditing] = useState<BoardTask | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  useEffect(() => { try { const v = localStorage.getItem("pm-view") as View | null; if (v) setView(v); } catch { /* ignore */ } }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem("pm-view", v); } catch { /* ignore */ } };

  const multi = clients.length > 1;
  const h: Handlers = { clients, multi, onCreate, onOpen: setEditing, onDrag: setDragId, dragId, onMove, onSetDay };
  const byStage = useMemo(() => { const m: Record<string, BoardTask[]> = {}; for (const s of STAGES) m[s.key] = []; for (const t of tasks) (m[t.stage] || m.todo).push(t); return m; }, [tasks]);
  const views: [View, string][] = [["kanban", "Kanban"], ["swimlanes", "Swimlanes"], ["list", "List"], ["timeline", "Week"], ["pipeline", "Pipeline"]];

  return (
    <>
      <div className="pm-boardbar">
        <label className="pm-viewdd"><span>View</span>
          <select value={view} onChange={(e) => pickView(e.target.value as View)}>{views.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
        </label>
      </div>
      {view === "kanban" && <KanbanView byStage={byStage} h={h} />}
      {view === "swimlanes" && <SwimlanesView tasks={tasks} h={h} />}
      {view === "list" && <ListView byStage={byStage} h={h} />}
      {view === "timeline" && <TimelineView tasks={tasks} h={h} />}
      {view === "pipeline" && <PipelineView tasks={tasks} h={h} />}
      {editing && <TaskEditor task={editing} clientName={multi ? editing.clientName : undefined} onClose={() => setEditing(null)} onSave={(f) => { onUpdate(editing.id, f); setEditing(null); }} onDelete={() => { onDelete(editing.id); setEditing(null); }} />}
    </>
  );
}
export { STAGES, scoreClass, fmtDT };
