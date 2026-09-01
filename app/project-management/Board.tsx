// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";

export type BoardTask = { id: string; title: string; stage: string; owner: string | null; due_date: string | null; context?: string | null; links?: string[]; source: string; clientSlug?: string; clientName?: string };
export type BoardClient = { slug: string; name: string; logoUrl?: string | null; accentColor?: string | null };
type View = "kanban" | "byclient" | "table" | "swimlanes" | "list" | "timeline" | "pipeline";
export type NewFields = { title: string; stage: string; assignee?: string; dueDate?: string; context?: string; links?: string[] };

const STAGES: { key: string; label: string; cls: string }[] = [
  { key: "todo", label: "To do", cls: "todo" },
  { key: "in_progress", label: "In progress", cls: "prog" },
  { key: "paused", label: "Paused", cls: "pause" },
  { key: "completed", label: "Completed", cls: "done" },
  { key: "launched", label: "Launched", cls: "launch" },
];
const stageOf = (k: string) => STAGES.find((x) => x.key === k) ?? STAGES[0];
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();
const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
const sourceLabel = (s: string) => (s === "morning_brief" ? "From brief" : s === "call_analysis" ? "From call" : "");
const linkLabel = (u: string) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, ""); } catch { return u; } };
const shortDate = (v?: string | null) => (v ? new Date(v + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
function iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function weekdays() { const now = new Date(); const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); const t = iso(now); return ["Mon", "Tue", "Wed", "Thu", "Fri"].map((label, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return { label, date: iso(d), today: iso(d) === t }; }); }
function weekOf() { const n = new Date(); const mon = new Date(n); mon.setDate(n.getDate() - ((n.getDay() + 6) % 7)); return `${mon.getMonth() + 1}/${mon.getDate()}`; }

type EditorState = { mode: "new"; stage: string; clientSlug?: string } | { mode: "edit"; task: BoardTask } | null;
type Handlers = {
  clients: BoardClient[]; multi: boolean; people: string[];
  openNew: (stage: string, clientSlug?: string) => void;
  onOpen: (t: BoardTask) => void;
  onDrag: (id: string | null) => void; dragId: string | null;
  onMove: (id: string, stage: string) => void; onSetDay: (id: string, date: string) => void;
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
        {t.due_date && <span className="pm-due">{shortDate(t.due_date)}</span>}
        {Array.isArray(t.links) && t.links.length > 0 && <span className="pm-clip">🔗 {t.links.length}</span>}
      </div>
    </div>
  );
}

/* ── 1 Kanban ── */
function KanbanView({ byStage, h }: { byStage: Record<string, BoardTask[]>; h: Handlers }) {
  return (
    <div className="pm-kb">
      {STAGES.map((s) => (
        <div className="pm-col" key={s.key} onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onMove(h.dragId, s.key)}>
          <div className="pm-colh"><span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span><span className="pm-n">{byStage[s.key].length}</span></div>
          {byStage[s.key].map((t) => <Card key={t.id} t={t} h={h} />)}
          <button type="button" className="pm-add" onClick={() => h.openNew(s.key)}>+ Add</button>
        </div>
      ))}
    </div>
  );
}

/* ── 2 By client (one column per client) ── */
function ByClientView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  return (
    <div className="pm-byclient" style={{ gridTemplateColumns: `repeat(${Math.max(1, h.clients.length)}, minmax(240px, 1fr))` }}>
      {h.clients.map((c) => {
        const mine = tasks.filter((t) => t.clientSlug === c.slug);
        return (
          <div className="pm-col" key={c.slug}>
            <div className="pm-colh pm-colh-client">
              <span className="pm-member-logo" style={c.logoUrl ? undefined : { background: c.accentColor || "var(--accent)" }}>{c.logoUrl ? <img src={c.logoUrl} alt="" /> : initials(c.name)}</span>
              <b>{c.name}</b><span className="pm-n">{mine.length}</span>
            </div>
            {mine.map((t) => (
              <div className="pm-card2" key={t.id} onClick={() => h.onOpen(t)} draggable onDragStart={(e) => { e.dataTransfer.setData("id", t.id); h.onDrag(t.id); }} onDragEnd={() => h.onDrag(null)}>
                <div className="pm-c-title">{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</div>
                <div className="pm-c-meta"><span className={`pm-stg ${stageOf(t.stage).cls}`}><span className="d" />{stageOf(t.stage).label}</span>{t.owner ? <span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span> : null}{t.due_date && <span className="pm-due">{shortDate(t.due_date)}</span>}</div>
              </div>
            ))}
            <button type="button" className="pm-add" onClick={() => h.openNew("todo", c.slug)}>+ Add</button>
          </div>
        );
      })}
    </div>
  );
}

/* ── 3 Table (Google-Docs style) ── */
function TableView({ tasks, h, title }: { tasks: BoardTask[]; h: Handlers; title: string }) {
  return (
    <div className="pm-table-wrap">
      <div className="pm-table-title"><h2>{title}</h2><p>Week of {weekOf()}</p></div>
      <div className="pm-table-scroll">
        <table className="pm-table">
          <thead><tr><th>Client</th><th>Task name</th><th>Assigned to</th><th>Status</th><th>Context</th><th>Due date</th></tr></thead>
          <tbody>
            {tasks.map((t) => {
              const c = h.clients.find((x) => x.slug === t.clientSlug);
              return (
                <tr key={t.id} onClick={() => h.onOpen(t)}>
                  <td>{c ? <span className="pm-cchip">{c.logoUrl ? <img src={c.logoUrl} alt="" /> : <span className="pm-cchip-mono" style={{ background: c.accentColor || "var(--accent)" }}>{initials(c.name)}</span>}{c.name}</span> : "—"}</td>
                  <td className="pm-td-title">{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</td>
                  <td>{t.owner ? <span className="pm-td-assignee"><span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span>{t.owner}</span> : <span className="pm-muted">—</span>}</td>
                  <td><span className={`pm-stg ${stageOf(t.stage).cls}`}><span className="d" />{stageOf(t.stage).label}</span></td>
                  <td className="pm-td-context">{t.context || <span className="pm-muted">—</span>}</td>
                  <td>{t.due_date ? shortDate(t.due_date) : <span className="pm-muted">—</span>}</td>
                </tr>
              );
            })}
            {tasks.length === 0 && <tr><td colSpan={6} className="pm-td-empty">No tasks yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <button type="button" className="pm-add pm-table-add" onClick={() => h.openNew("todo", h.multi ? undefined : h.clients[0]?.slug)}>+ Add a task</button>
    </div>
  );
}

/* ── 4 Swimlanes ── */
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

/* ── 5 List ── */
function ListView({ byStage, h }: { byStage: Record<string, BoardTask[]>; h: Handlers }) {
  return (
    <div className="pm-list">
      {STAGES.map((s) => (
        <div className="pm-lgrp" key={s.key} onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onMove(h.dragId, s.key)}>
          <div className="pm-lgh"><span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span><span className="pm-n">{byStage[s.key].length}</span><span className="pm-lgh-add"><button type="button" className="pm-add" onClick={() => h.openNew(s.key)}>+ Add</button></span></div>
          {byStage[s.key].map((t) => (
            <div className="pm-lrow" key={t.id} draggable onDragStart={(e) => { e.dataTransfer.setData("id", t.id); h.onDrag(t.id); }} onDragEnd={() => h.onDrag(null)} onClick={() => h.onOpen(t)}>
              <span className="pm-grip">⠿</span>
              {t.owner ? <span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span> : <span className="pm-av pm-av-none">?</span>}
              <span className="pm-lt">{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</span>
              {h.multi && <ClientChip t={t} clients={h.clients} />}
              {t.due_date && <span className="pm-due">{shortDate(t.due_date)}</span>}
            </div>
          ))}
          {byStage[s.key].length === 0 && <div className="pm-lempty">Drop a task here</div>}
        </div>
      ))}
    </div>
  );
}

/* ── 6 Week timeline ── */
function TimelineView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  const days = weekdays();
  const unsched = tasks.filter((t) => !t.due_date || !days.some((d) => d.date === t.due_date));
  return (
    <div className="pm-tl">
      <div className="pm-day pm-unsched" onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onSetDay(h.dragId, "")}>
        <div className="pm-dayh">Unscheduled <span>{unsched.length}</span></div>
        {unsched.map((t) => <Card key={t.id} t={t} h={h} />)}
        <button type="button" className="pm-add" onClick={() => h.openNew("todo", h.multi ? undefined : h.clients[0]?.slug)}>+ Add</button>
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

/* ── 7 Pipeline ── */
function PipelineView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  return (
    <div className="pm-pipe">
      {tasks.map((t) => {
        const idx = STAGES.findIndex((s) => s.key === t.stage);
        return (
          <div className="pm-prow" key={t.id}>
            <span className="pm-pt" onClick={() => h.onOpen(t)}>{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}{h.multi && <ClientChip t={t} clients={h.clients} />}</span>
            <div className="pm-track">{STAGES.map((s, i) => <button type="button" key={s.key} className={`pm-seg ${i <= idx ? `on ${s.cls}` : ""}`} title={`Move to ${s.label}`} onClick={() => h.onMove(t.id, s.key)}>{s.label}</button>)}</div>
            {t.owner ? <span className="pm-av" style={{ background: `hsl(${hue(t.owner)} 55% 45%)` }}>{initials(t.owner)}</span> : <span className="pm-av pm-av-none">?</span>}
          </div>
        );
      })}
      <div className="pm-prow pm-prow-add"><button type="button" className="pm-add" onClick={() => h.openNew("todo", h.multi ? undefined : h.clients[0]?.slug)}>+ Add a project</button></div>
    </div>
  );
}

/* ── Assignee picker (choose a person, or add one) ── */
function AssigneeSelect({ value, people, onChange, onAddPerson }: { value: string; people: string[]; onChange: (v: string) => void; onAddPerson: (name: string) => void }) {
  return (
    <select value={value} onChange={(e) => { if (e.target.value === "__add__") { const n = window.prompt("Add a teammate:")?.trim(); if (n) { onAddPerson(n); onChange(n); } } else onChange(e.target.value); }}>
      <option value="">Unassigned</option>
      {people.map((p) => <option key={p} value={p}>{p}</option>)}
      {value && !people.includes(value) && <option value={value}>{value}</option>}
      <option value="__add__">＋ Add a person…</option>
    </select>
  );
}

/* ── Unified editor: new or edit ── */
function TaskEditor({ state, clients, people, multi, onAddPerson, onClose, onCreate, onUpdate, onDelete }: {
  state: Exclude<EditorState, null>; clients: BoardClient[]; people: string[]; multi: boolean;
  onAddPerson: (name: string) => void; onClose: () => void;
  onCreate: (clientSlug: string, f: NewFields) => void; onUpdate: (id: string, f: Record<string, unknown>) => void; onDelete: (id: string) => void;
}) {
  const isNew = state.mode === "new";
  const task = isNew ? null : state.task;
  const [title, setTitle] = useState(task?.title ?? "");
  const [slug, setSlug] = useState((isNew ? state.clientSlug : task?.clientSlug) ?? clients[0]?.slug ?? "");
  const [owner, setOwner] = useState(task?.owner ?? "");
  const [due, setDue] = useState(task?.due_date ?? "");
  const [stage, setStage] = useState(isNew ? state.stage : task?.stage ?? "todo");
  const [context, setContext] = useState(task?.context ?? "");
  const [links, setLinks] = useState<string[]>(Array.isArray(task?.links) ? task!.links! : []);
  const [newLink, setNewLink] = useState("");
  const addLink = () => { const u = newLink.trim(); if (!u) return; setLinks((p) => [...p, /^https?:\/\//i.test(u) ? u : `https://${u}`]); setNewLink(""); };
  const clientName = clients.find((c) => c.slug === slug)?.name;

  const save = () => {
    if (!title.trim()) return;
    if (isNew) { if (!slug) return; onCreate(slug, { title, stage, assignee: owner, dueDate: due, context, links }); }
    else onUpdate(task!.id, { title, owner, dueDate: due, stage, context, links });
    onClose();
  };
  return (
    <div className="pm-modal-back" onClick={onClose}>
      <div className="pm-modal pm-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="pm-modal-head"><h2>{isNew ? "New task" : "Task details"}{clientName && multi ? ` · ${clientName}` : ""}</h2><button type="button" className="pm-modal-x" onClick={onClose}>✕</button></div>
        <div className="pm-modal-body">
          {isNew && multi && (
            <label className="pm-f"><span>Client</span>
              <select value={slug} onChange={(e) => setSlug(e.target.value)}>{clients.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
            </label>
          )}
          <label className="pm-f"><span>Title</span><input autoFocus value={title} placeholder="What needs doing?" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }} /></label>
          <div className="pm-f-row">
            <label className="pm-f"><span>Assignee</span><AssigneeSelect value={owner} people={people} onChange={setOwner} onAddPerson={onAddPerson} /></label>
            <label className="pm-f"><span>Due date</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
            <label className="pm-f"><span>Stage</span><select value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          </div>
          <label className="pm-f"><span>Context / notes</span><textarea rows={3} value={context} onChange={(e) => setContext(e.target.value)} /></label>
          <div className="pm-f"><span>Links &amp; files</span><div className="pm-links">
            {links.map((u, i) => <div className="pm-link" key={i}><a href={u} target="_blank" rel="noreferrer">{linkLabel(u)}</a><button type="button" onClick={() => setLinks((p) => p.filter((_, j) => j !== i))}>✕</button></div>)}
            <div className="pm-link-add"><input value={newLink} placeholder="Paste a URL…" onChange={(e) => setNewLink(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} /><button type="button" onClick={addLink}>Add</button></div>
          </div></div>
        </div>
        <div className="pm-modal-foot">{!isNew ? <button type="button" className="pm-del" onClick={() => { onDelete(task!.id); onClose(); }}>Delete</button> : <span />}<button type="button" className="pm-save" onClick={save}>{isNew ? "Create task" : "Save"}</button></div>
      </div>
    </div>
  );
}

export default function ProjectBoard({ tasks, clients, tableTitle, onCreate, onUpdate, onDelete, onMove, onSetDay }: {
  tasks: BoardTask[]; clients: BoardClient[]; tableTitle?: string;
  onCreate: (clientSlug: string, fields: NewFields) => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => void;
  onDelete: (id: string) => void; onMove: (id: string, stage: string) => void; onSetDay: (id: string, date: string) => void;
}) {
  const [view, setView] = useState<View>("kanban");
  const [editor, setEditor] = useState<EditorState>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => { try { const v = localStorage.getItem("pm-view") as View | null; if (v) setView(v); } catch { /* ignore */ } }, []);
  useEffect(() => { void fetch("/api/project-management/people", { cache: "no-store" }).then((r) => r.json()).then((p) => setPeople(Array.isArray(p.people) ? p.people : [])).catch(() => {}); }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem("pm-view", v); } catch { /* ignore */ } };
  const addPerson = (name: string) => { setPeople((p) => (p.some((x) => x.toLowerCase() === name.toLowerCase()) ? p : [...p, name].sort())); void fetch("/api/project-management/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => {}); };

  const multi = clients.length > 1;
  const h: Handlers = { clients, multi, people, openNew: (stage, clientSlug) => setEditor({ mode: "new", stage, clientSlug }), onOpen: (t) => setEditor({ mode: "edit", task: t }), onDrag: setDragId, dragId, onMove, onSetDay };
  const byStage = useMemo(() => { const m: Record<string, BoardTask[]> = {}; for (const s of STAGES) m[s.key] = []; for (const t of tasks) (m[t.stage] || m.todo).push(t); return m; }, [tasks]);
  const views: [View, string][] = [["kanban", "Kanban"], ...(multi ? [["byclient", "By client"] as [View, string]] : []), ["table", "Table"], ["swimlanes", "Swimlanes"], ["list", "List"], ["timeline", "Week"], ["pipeline", "Pipeline"]];

  return (
    <>
      <div className="pm-boardbar">
        <label className="pm-viewdd"><span>View</span>
          <select value={view} onChange={(e) => pickView(e.target.value as View)}>{views.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
        </label>
      </div>
      {view === "kanban" && <KanbanView byStage={byStage} h={h} />}
      {view === "byclient" && multi && <ByClientView tasks={tasks} h={h} />}
      {view === "table" && <TableView tasks={tasks} h={h} title={tableTitle || "Tasks"} />}
      {view === "swimlanes" && <SwimlanesView tasks={tasks} h={h} />}
      {view === "list" && <ListView byStage={byStage} h={h} />}
      {view === "timeline" && <TimelineView tasks={tasks} h={h} />}
      {view === "pipeline" && <PipelineView tasks={tasks} h={h} />}
      {editor && <TaskEditor state={editor} clients={clients} people={people} multi={multi} onAddPerson={addPerson} onClose={() => setEditor(null)} onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} />}
    </>
  );
}
