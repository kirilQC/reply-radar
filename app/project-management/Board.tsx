// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";

export type BoardTask = { id: string; title: string; stage: string; owner: string | null; due_date: string | null; context?: string | null; links?: string[]; priority?: string | null; week?: string | null; source: string; clientSlug?: string; clientName?: string };
export type BoardClient = { slug: string; name: string; logoUrl?: string | null; accentColor?: string | null };
type View = "kanban" | "byclient" | "individuals" | "table" | "swimlanes" | "list" | "timeline" | "pipeline";
export type NewFields = { title: string; stage: string; assignee?: string; dueDate?: string; context?: string; links?: string[]; priority?: string; week?: string };

const STAGES = [
  { key: "todo", label: "To do", cls: "todo" },
  { key: "in_progress", label: "In progress", cls: "prog" },
  { key: "paused", label: "Paused", cls: "pause" },
  { key: "completed", label: "Completed", cls: "done" },
  { key: "launched", label: "Launched", cls: "launch" },
];
const PRIORITIES = [{ key: "high", label: "High", color: "#e5484d" }, { key: "medium", label: "Medium", color: "#f2913d" }, { key: "low", label: "Low", color: "#e6c229" }];
const stageOf = (k: string) => STAGES.find((x) => x.key === k) ?? STAGES[0];
const prioOf = (k?: string | null) => PRIORITIES.find((x) => x.key === k) ?? null;
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();
const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
const ownerList = (o?: string | null) => (o ? o.split(",").map((s) => s.trim()).filter(Boolean) : []);
const linkLabel = (u: string) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, ""); } catch { return u; } };
const parseLinks = (raw: string) => raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`)).slice(0, 30);
const shortDate = (v?: string | null) => { if (!v) return ""; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00" : v); return Number.isNaN(+d) ? v : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
function iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function weekLabel(w: string) { const d = new Date(w + "T00:00"); return Number.isNaN(+d) ? w : "Week of " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function weekdays() { const now = new Date(); const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); const t = iso(now); return ["Mon", "Tue", "Wed", "Thu", "Fri"].map((label, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return { label, date: iso(d), today: iso(d) === t }; }); }

/* ── Reusable custom dropdown (no native <select>) ── */
type Opt = { value: string; label: string; logo?: React.ReactNode; color?: string };
function Chevron() { return <svg className="pm-chev" viewBox="0 0 10 6" width="10" height="6" aria-hidden><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function useMenu(minW = 0) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const toggle = () => { if (pos) { setPos(null); return; } const r = btnRef.current?.getBoundingClientRect(); if (r) setPos({ top: r.bottom + 5, left: r.left, width: Math.max(r.width, minW) }); };
  const close = () => setPos(null);
  useEffect(() => { if (!pos) return; const h = () => setPos(null); window.addEventListener("scroll", h, true); window.addEventListener("resize", h); return () => { window.removeEventListener("scroll", h, true); window.removeEventListener("resize", h); }; }, [pos]);
  return { btnRef, pos, open: !!pos, toggle, close };
}
function Select({ value, options, onChange, placeholder, minWidth, tone }: { value: string; options: Opt[]; onChange: (v: string) => void; placeholder?: string; minWidth?: number; tone?: string }) {
  const m = useMenu(minWidth ?? 150);
  const cur = options.find((o) => o.value === value);
  return (
    <div className="pm-dd">
      <button ref={m.btnRef} type="button" className="pm-dd-btn" style={tone ? { color: tone } : undefined} onClick={(e) => { e.stopPropagation(); m.toggle(); }}>
        <span className="pm-dd-val">{cur ? <>{cur.logo}{cur.color && <i className="pm-dd-dot" style={{ background: cur.color }} />}{cur.label}</> : <span className="pm-dd-ph">{placeholder ?? "—"}</span>}</span><Chevron />
      </button>
      {m.open && m.pos && <>
        <div className="pm-dd-back" onClick={(e) => { e.stopPropagation(); m.close(); }} />
        <div className="pm-dd-menu" style={{ top: m.pos.top, left: m.pos.left, minWidth: m.pos.width }}>
          {options.map((o) => <button key={o.value} type="button" className={`pm-dd-opt ${o.value === value ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); onChange(o.value); m.close(); }}>{o.logo}{o.color && <i className="pm-dd-dot" style={{ background: o.color }} />}<span className="pm-dd-opt-l">{o.label}</span>{o.value === value && <span className="pm-dd-ck">✓</span>}</button>)}
        </div>
      </>}
    </div>
  );
}
function avatar(name: string, cls = "") { return <span key={name} className={`pm-av ${cls}`} style={{ background: `hsl(${hue(name)} 55% 45%)` }}>{initials(name)}</span>; }
function MultiPeople({ value, people, onChange, addPerson, removePerson, placeholder = "Unassigned" }: { value: string; people: string[]; onChange: (v: string) => void; addPerson: (n: string) => void; removePerson: (n: string) => void; placeholder?: string }) {
  const m = useMenu(200); const sel = ownerList(value); const [draft, setDraft] = useState("");
  const toggle = (name: string) => { const next = sel.includes(name) ? sel.filter((x) => x !== name) : [...sel, name]; onChange(next.join(", ")); };
  const add = () => { const n = draft.trim(); if (!n) return; addPerson(n); if (!sel.includes(n)) onChange([...sel, n].join(", ")); setDraft(""); };
  const roster = Array.from(new Set([...people, ...sel]));
  return (
    <div className="pm-dd">
      <button ref={m.btnRef} type="button" className="pm-dd-btn" onClick={(e) => { e.stopPropagation(); m.toggle(); }}>
        <span className="pm-dd-val">{sel.length ? <span className="pm-av-row">{sel.slice(0, 3).map((n) => avatar(n))}<span className="pm-av-names">{sel.length === 1 ? sel[0] : `${sel.length} people`}</span></span> : <span className="pm-dd-ph">{placeholder}</span>}</span><Chevron />
      </button>
      {m.open && m.pos && <>
        <div className="pm-dd-back" onClick={(e) => { e.stopPropagation(); m.close(); }} />
        <div className="pm-dd-menu" style={{ top: m.pos.top, left: m.pos.left, minWidth: m.pos.width }} onClick={(e) => e.stopPropagation()}>
          {roster.map((p) => (
            <div className={`pm-dd-opt multi ${sel.includes(p) ? "on" : ""}`} key={p}>
              <button type="button" className="pm-dd-optmain" onClick={() => toggle(p)}><span className={`pm-check ${sel.includes(p) ? "on" : ""}`}>{sel.includes(p) ? "✓" : ""}</span>{avatar(p)}<span className="pm-dd-opt-l">{p}</span></button>
              <button type="button" className="pm-dd-rm" title="Remove from roster" onClick={() => removePerson(p)}>✕</button>
            </div>
          ))}
          <div className="pm-dd-add"><input value={draft} placeholder="Add a person…" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /><button type="button" onClick={add}>Add</button></div>
        </div>
      </>}
    </div>
  );
}

type EditorState = { mode: "new"; stage: string; clientSlug?: string; assignee?: string } | { mode: "edit"; task: BoardTask } | null;
type Handlers = {
  clients: BoardClient[]; multi: boolean; people: string[]; addPerson: (n: string) => void; removePerson: (n: string) => void;
  openNew: (stage: string, clientSlug?: string, assignee?: string) => void; onOpen: (t: BoardTask) => void;
  onDrag: (id: string | null) => void; dragId: string | null; onMove: (id: string, stage: string) => void; onSetDay: (id: string, date: string) => void;
};
function clientLogo(c: BoardClient) { return c.logoUrl ? <img className="pm-opt-logo" src={c.logoUrl} alt="" /> : <span className="pm-opt-logo mono" style={{ background: c.accentColor || "var(--accent)" }}>{initials(c.name)}</span>; }

function PriorityDot({ p }: { p?: string | null }) { const pr = prioOf(p); return pr ? <span className="pm-prio" style={{ background: pr.color }} title={`${pr.label} priority`} /> : null; }
function Owners({ owner }: { owner?: string | null }) { const list = ownerList(owner); if (!list.length) return null; return <span className="pm-av-row">{list.slice(0, 3).map((n) => avatar(n))}</span>; }
function ClientChip({ t, clients }: { t: BoardTask; clients: BoardClient[] }) {
  const c = clients.find((x) => x.slug === t.clientSlug); if (!c) return null;
  return <span className="pm-cchip">{c.logoUrl ? <img src={c.logoUrl} alt="" /> : <span className="pm-cchip-mono" style={{ background: c.accentColor || "var(--accent)" }}>{initials(c.name)}</span>}{c.name}</span>;
}
function Card({ t, h }: { t: BoardTask; h: Handlers }) {
  return (
    <div className="pm-card2" draggable onDragStart={(e) => { e.dataTransfer.setData("id", t.id); h.onDrag(t.id); }} onDragEnd={() => h.onDrag(null)} onClick={() => h.onOpen(t)}>
      <div className="pm-c-title"><PriorityDot p={t.priority} />{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</div>
      <div className="pm-c-meta">
        {h.multi && <ClientChip t={t} clients={h.clients} />}
        <Owners owner={t.owner} />
        {t.due_date && <span className="pm-due">{shortDate(t.due_date)}</span>}
        {Array.isArray(t.links) && t.links.length > 0 && <span className="pm-clip">🔗 {t.links.length}</span>}
      </div>
    </div>
  );
}

function KanbanView({ byStage, h }: { byStage: Record<string, BoardTask[]>; h: Handlers }) {
  return (
    <div className="pm-kb">
      {STAGES.map((s) => (
        <div className="pm-col" key={s.key} onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onMove(h.dragId, s.key)}>
          <div className="pm-colh"><span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span></div>
          {byStage[s.key].map((t) => <Card key={t.id} t={t} h={h} />)}
          {s.key === "todo" && <button type="button" className="pm-add" onClick={() => h.openNew("todo")}>+ Add</button>}
        </div>
      ))}
    </div>
  );
}
function ColumnList({ label, logo, tasks, onAdd, h }: { label: React.ReactNode; logo?: React.ReactNode; tasks: BoardTask[]; onAdd: () => void; h: Handlers }) {
  return (
    <div className="pm-col">
      <div className="pm-colh pm-colh-big">{logo}<b>{label}</b></div>
      {tasks.map((t) => (
        <div className="pm-card2" key={t.id} onClick={() => h.onOpen(t)} draggable onDragStart={(e) => { e.dataTransfer.setData("id", t.id); h.onDrag(t.id); }} onDragEnd={() => h.onDrag(null)}>
          <div className="pm-c-title"><PriorityDot p={t.priority} />{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</div>
          <div className="pm-c-meta"><span className={`pm-stg ${stageOf(t.stage).cls}`}><span className="d" />{stageOf(t.stage).label}</span><Owners owner={t.owner} />{t.due_date && <span className="pm-due">{shortDate(t.due_date)}</span>}</div>
        </div>
      ))}
      <button type="button" className="pm-add" onClick={onAdd}>+ Add</button>
    </div>
  );
}
function ByClientView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  return (
    <div className="pm-cols" style={{ gridTemplateColumns: `repeat(${Math.max(1, h.clients.length)}, minmax(260px, 1fr))` }}>
      {h.clients.map((c) => (
        <ColumnList key={c.slug} label={c.name} logo={<span className="pm-bighead-logo" style={c.logoUrl ? undefined : { background: c.accentColor || "var(--accent)" }}>{c.logoUrl ? <img src={c.logoUrl} alt="" /> : initials(c.name)}</span>} tasks={tasks.filter((t) => t.clientSlug === c.slug)} onAdd={() => h.openNew("todo", c.slug)} h={h} />
      ))}
    </div>
  );
}
function IndividualsView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  const owners = useMemo(() => { const set = new Set<string>(h.people); for (const t of tasks) for (const o of ownerList(t.owner)) set.add(o); const arr = Array.from(set); arr.push("Unassigned"); return arr; }, [tasks, h.people]);
  return (
    <div className="pm-cols" style={{ gridTemplateColumns: `repeat(${Math.max(1, owners.length)}, minmax(240px, 1fr))` }}>
      {owners.map((o) => (
        <ColumnList key={o} label={o} logo={<span className="pm-bighead-logo" style={{ background: o === "Unassigned" ? "var(--muted-2,#555)" : `hsl(${hue(o)} 55% 45%)` }}>{initials(o)}</span>} tasks={tasks.filter((t) => { const l = ownerList(t.owner); return o === "Unassigned" ? l.length === 0 : l.includes(o); })} onAdd={() => h.openNew("todo", h.multi ? undefined : h.clients[0]?.slug, o === "Unassigned" ? "" : o)} h={h} />
      ))}
    </div>
  );
}

/* ── Inline-editable table ── */
type Draft = { key: string; clientSlug: string; title: string; owner: string; stage: string; context: string; due: string; priority: string; links: string };
function TableView({ tasks, h, onUpdate, onCreate, week, people }: { tasks: BoardTask[]; h: Handlers; onUpdate: (id: string, f: Record<string, unknown>) => void; onCreate: (slug: string, f: NewFields) => void; week?: string; people: string[] }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const clientOpts: Opt[] = h.clients.map((c) => ({ value: c.slug, label: c.name, logo: clientLogo(c) }));
  const stageOpts: Opt[] = STAGES.map((s) => ({ value: s.key, label: s.label }));
  const prioOpts: Opt[] = [{ value: "", label: "None" }, ...PRIORITIES.map((p) => ({ value: p.key, label: p.label, color: p.color }))];
  const addDraft = () => setDrafts((d) => [...d, { key: `d${d.length}-${tasks.length}`, clientSlug: h.clients[0]?.slug ?? "", title: "", owner: "", stage: "todo", context: "", due: "", priority: "", links: "" }]);
  const setDraft = (key: string, patch: Partial<Draft>) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const commit = (key: string) => { const d = drafts.find((x) => x.key === key); if (!d || !d.title.trim() || !d.clientSlug) return; onCreate(d.clientSlug, { title: d.title, stage: d.stage, assignee: d.owner, dueDate: d.due, context: d.context, priority: d.priority, links: parseLinks(d.links), week }); setDrafts((p) => p.filter((x) => x.key !== key)); };
  return (
    <div className="pm-table-wrap">
      <div className="pm-table-scroll">
        <table className="pm-table pm-table-edit">
          <colgroup><col style={{ width: "12%" }} /><col style={{ width: "17%" }} /><col style={{ width: "12%" }} /><col style={{ width: "8%" }} /><col style={{ width: "10%" }} /><col /><col style={{ width: "15%" }} /><col style={{ width: "9%" }} /><col style={{ width: 34 }} /></colgroup>
          <thead><tr><th>Client</th><th>Task name</th><th>Assigned to</th><th>Priority</th><th>Status</th><th>Context</th><th>Links</th><th>Due date</th><th /></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td><Select value={t.clientSlug ?? ""} options={clientOpts} onChange={(v) => onUpdate(t.id, { moveToSlug: v })} /></td>
                <td><input className="pm-cellin" defaultValue={t.title} onBlur={(e) => { if (e.target.value !== t.title) onUpdate(t.id, { title: e.target.value }); }} /></td>
                <td><MultiPeople value={t.owner || ""} people={people} onChange={(v) => onUpdate(t.id, { owner: v })} addPerson={h.addPerson} removePerson={h.removePerson} /></td>
                <td><Select value={t.priority || ""} options={prioOpts} placeholder="None" tone={prioOf(t.priority)?.color} onChange={(v) => onUpdate(t.id, { priority: v })} /></td>
                <td><Select value={t.stage} options={stageOpts} onChange={(v) => onUpdate(t.id, { stage: v })} /></td>
                <td><input className="pm-cellin" defaultValue={t.context || ""} onBlur={(e) => { if ((e.target.value || null) !== (t.context || null)) onUpdate(t.id, { context: e.target.value }); }} /></td>
                <td><input className="pm-cellin" defaultValue={(t.links || []).join(", ")} placeholder="Paste URLs…" onBlur={(e) => { const next = parseLinks(e.target.value); if (next.join(",") !== (t.links || []).join(",")) onUpdate(t.id, { links: next }); }} /></td>
                <td><input className="pm-cellin" defaultValue={t.due_date || ""} placeholder="e.g. Thu 9/4" onBlur={(e) => { if ((e.target.value || null) !== (t.due_date || null)) onUpdate(t.id, { dueDate: e.target.value }); }} /></td>
                <td><button type="button" className="pm-rowdel" title="Open" onClick={() => h.onOpen(t)}>⋯</button></td>
              </tr>
            ))}
            {drafts.map((d) => (
              <tr key={d.key} className="pm-draftrow">
                <td><Select value={d.clientSlug} options={clientOpts} onChange={(v) => setDraft(d.key, { clientSlug: v })} /></td>
                <td><input className="pm-cellin" autoFocus value={d.title} placeholder="New task…" onChange={(e) => setDraft(d.key, { title: e.target.value })} onBlur={() => commit(d.key)} onKeyDown={(e) => { if (e.key === "Enter") commit(d.key); }} /></td>
                <td><MultiPeople value={d.owner} people={people} onChange={(v) => setDraft(d.key, { owner: v })} addPerson={h.addPerson} removePerson={h.removePerson} /></td>
                <td><Select value={d.priority} options={prioOpts} placeholder="None" tone={prioOf(d.priority)?.color} onChange={(v) => setDraft(d.key, { priority: v })} /></td>
                <td><Select value={d.stage} options={stageOpts} onChange={(v) => setDraft(d.key, { stage: v })} /></td>
                <td><input className="pm-cellin" value={d.context} onChange={(e) => setDraft(d.key, { context: e.target.value })} /></td>
                <td><input className="pm-cellin" value={d.links} placeholder="Paste URLs…" onChange={(e) => setDraft(d.key, { links: e.target.value })} /></td>
                <td><input className="pm-cellin" value={d.due} placeholder="e.g. Thu 9/4" onChange={(e) => setDraft(d.key, { due: e.target.value })} /></td>
                <td><button type="button" className="pm-rowdel" onClick={() => setDrafts((p) => p.filter((x) => x.key !== d.key))}>✕</button></td>
              </tr>
            ))}
            {tasks.length === 0 && drafts.length === 0 && <tr><td colSpan={9} className="pm-td-empty">No tasks yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <button type="button" className="pm-add pm-table-add" onClick={addDraft}>+ Add a task</button>
    </div>
  );
}

function SwimlanesView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  const owners = useMemo(() => { const set = new Set<string>(); for (const t of tasks) { const l = ownerList(t.owner); if (!l.length) set.add("Unassigned"); else l.forEach((o) => set.add(o)); } return Array.from(set).sort(); }, [tasks]);
  const cols = [{ key: "todo", label: "To do" }, { key: "in_progress", label: "In progress" }, { key: "done", label: "Done / Launched" }];
  const inCol = (t: BoardTask, col: string) => col === "done" ? (t.stage === "completed" || t.stage === "launched") : col === "todo" ? (t.stage === "todo" || t.stage === "paused") : t.stage === "in_progress";
  const has = (t: BoardTask, owner: string) => { const l = ownerList(t.owner); return owner === "Unassigned" ? l.length === 0 : l.includes(owner); };
  const dropStage = (col: string) => col === "done" ? "completed" : col === "todo" ? "todo" : "in_progress";
  return (
    <div className="pm-sw" style={{ gridTemplateColumns: `130px repeat(${cols.length}, 1fr)` }}>
      <div className="pm-swch">Owner</div>{cols.map((c) => <div className="pm-swch" key={c.key}>{c.label}</div>)}
      {owners.map((owner) => (
        <div key={owner} style={{ display: "contents" }}>
          <div className="pm-swwho">{owner === "Unassigned" ? <span className="pm-av pm-av-none">?</span> : avatar(owner)}{owner}</div>
          {cols.map((c) => <div className="pm-swcell" key={c.key} onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onMove(h.dragId, dropStage(c.key))}>{tasks.filter((t) => has(t, owner) && inCol(t, c.key)).map((t) => <Card key={t.id} t={t} h={h} />)}</div>)}
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
          <div className="pm-lgh"><span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span>{s.key === "todo" && <span className="pm-lgh-add"><button type="button" className="pm-add" onClick={() => h.openNew("todo")}>+ Add</button></span>}</div>
          {byStage[s.key].map((t) => (
            <div className="pm-lrow" key={t.id} draggable onDragStart={(e) => { e.dataTransfer.setData("id", t.id); h.onDrag(t.id); }} onDragEnd={() => h.onDrag(null)} onClick={() => h.onOpen(t)}>
              <span className="pm-grip">⠿</span><PriorityDot p={t.priority} />
              {ownerList(t.owner).length ? <Owners owner={t.owner} /> : <span className="pm-av pm-av-none">?</span>}
              <span className="pm-lt">{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</span>{h.multi && <ClientChip t={t} clients={h.clients} />}{t.due_date && <span className="pm-due">{shortDate(t.due_date)}</span>}
            </div>
          ))}
          {byStage[s.key].length === 0 && <div className="pm-lempty">Drop a task here</div>}
        </div>
      ))}
    </div>
  );
}
function TimelineView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  const days = weekdays(); const unsched = tasks.filter((t) => !t.due_date || !days.some((d) => d.date === t.due_date));
  return (
    <div className="pm-tl">
      <div className="pm-day pm-unsched" onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onSetDay(h.dragId, "")}><div className="pm-dayh">Unscheduled</div>{unsched.map((t) => <Card key={t.id} t={t} h={h} />)}<button type="button" className="pm-add" onClick={() => h.openNew("todo", h.multi ? undefined : h.clients[0]?.slug)}>+ Add</button></div>
      {days.map((d) => { const dt = tasks.filter((t) => t.due_date === d.date); return <div className={`pm-day ${d.today ? "today" : ""}`} key={d.date} onDragOver={(e) => e.preventDefault()} onDrop={() => h.dragId && h.onSetDay(h.dragId, d.date)}><div className="pm-dayh">{d.label}{d.today ? " · today" : ""}</div>{dt.map((t) => <Card key={t.id} t={t} h={h} />)}</div>; })}
    </div>
  );
}
function PipelineView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  return (
    <div className="pm-pipe">
      {tasks.map((t) => { const idx = STAGES.findIndex((s) => s.key === t.stage); return (
        <div className="pm-prow" key={t.id}>
          <span className="pm-pt" onClick={() => h.onOpen(t)}><PriorityDot p={t.priority} />{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}{h.multi && <ClientChip t={t} clients={h.clients} />}</span>
          <div className="pm-track">{STAGES.map((s, i) => <button type="button" key={s.key} className={`pm-seg ${i <= idx ? `on ${s.cls}` : ""}`} onClick={() => h.onMove(t.id, s.key)}>{s.label}</button>)}</div>
          <Owners owner={t.owner} />
        </div>); })}
      <div className="pm-prow pm-prow-add"><button type="button" className="pm-add" onClick={() => h.openNew("todo", h.multi ? undefined : h.clients[0]?.slug)}>+ Add a project</button></div>
    </div>
  );
}

function TaskEditor({ state, clients, people, multi, addPerson, removePerson, onClose, onCreate, onUpdate, onDelete }: { state: Exclude<EditorState, null>; clients: BoardClient[]; people: string[]; multi: boolean; addPerson: (n: string) => void; removePerson: (n: string) => void; onClose: () => void; onCreate: (clientSlug: string, f: NewFields) => void; onUpdate: (id: string, f: Record<string, unknown>) => void; onDelete: (id: string) => void }) {
  const isNew = state.mode === "new"; const task = isNew ? null : state.task;
  const [title, setTitle] = useState(task?.title ?? "");
  const [slug, setSlug] = useState((isNew ? state.clientSlug : task?.clientSlug) ?? clients[0]?.slug ?? "");
  const [owner, setOwner] = useState((isNew ? state.assignee : task?.owner) ?? "");
  const [due, setDue] = useState(task?.due_date ?? "");
  const [priority, setPriority] = useState(task?.priority ?? "");
  const [context, setContext] = useState(task?.context ?? "");
  const [links, setLinks] = useState<string[]>(Array.isArray(task?.links) ? task!.links! : []);
  const [newLink, setNewLink] = useState("");
  const addLink = () => { const u = newLink.trim(); if (!u) return; setLinks((p) => [...p, /^https?:\/\//i.test(u) ? u : `https://${u}`]); setNewLink(""); };
  const clientName = clients.find((c) => c.slug === slug)?.name;
  const clientOpts: Opt[] = clients.map((c) => ({ value: c.slug, label: c.name, logo: clientLogo(c) }));
  const prioOpts: Opt[] = [{ value: "", label: "None" }, ...PRIORITIES.map((p) => ({ value: p.key, label: p.label, color: p.color }))];
  const save = () => { if (!title.trim()) return; if (isNew) { if (!slug) return; onCreate(slug, { title, stage: state.stage, assignee: owner, dueDate: due, context, links, priority }); } else onUpdate(task!.id, { title, owner, dueDate: due, context, links, priority }); onClose(); };
  return (
    <div className="pm-modal-back" onClick={onClose}>
      <div className="pm-modal pm-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="pm-modal-head"><h2>{isNew ? "New task" : "Task details"}{clientName && multi ? ` · ${clientName}` : ""}</h2><button type="button" className="pm-modal-x" onClick={onClose}>✕</button></div>
        <div className="pm-modal-body">
          {isNew && multi && <label className="pm-f"><span>Client</span><Select value={slug} options={clientOpts} onChange={setSlug} /></label>}
          <label className="pm-f"><span>Title</span><input autoFocus value={title} placeholder="What needs doing?" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }} /></label>
          <div className="pm-f-row">
            <label className="pm-f"><span>Assignees</span><MultiPeople value={owner} people={people} onChange={setOwner} addPerson={addPerson} removePerson={removePerson} /></label>
            <label className="pm-f"><span>Priority</span><Select value={priority} options={prioOpts} placeholder="None" tone={prioOf(priority)?.color} onChange={setPriority} /></label>
          </div>
          <label className="pm-f"><span>Due date</span><input value={due} placeholder="e.g. Thu 9/4 or 2026-09-04" onChange={(e) => setDue(e.target.value)} /></label>
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

const ALL_WEEK = "__all__", ADD_WEEK = "__addweek__";
export default function ProjectBoard({ tasks, clients, defaultView, onCreate, onUpdate, onDelete, onMove, onSetDay }: {
  tasks: BoardTask[]; clients: BoardClient[]; defaultView?: View;
  onCreate: (clientSlug: string, fields: NewFields) => void; onUpdate: (id: string, fields: Record<string, unknown>) => void; onDelete: (id: string) => void; onMove: (id: string, stage: string) => void; onSetDay: (id: string, date: string) => void;
}) {
  const multi = clients.length > 1;
  const [view, setView] = useState<View>(defaultView ?? "kanban");
  const [editor, setEditor] = useState<EditorState>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [people, setPeople] = useState<string[]>([]);
  const [week, setWeek] = useState<string>("");        // "" = all time (weekly only lives on group views)
  const [extraWeeks, setExtraWeeks] = useState<string[]>([]);
  useEffect(() => { try { const v = localStorage.getItem("pm-view") as View | null; const ok = (v && v !== "byclient") || (v === "byclient" && multi); if (v && ok) setView(v); else if (defaultView) setView(defaultView); } catch { /* ignore */ } }, [defaultView, multi]);
  useEffect(() => { void fetch("/api/project-management/people", { cache: "no-store" }).then((r) => r.json()).then((p) => setPeople(Array.isArray(p.people) ? p.people : [])).catch(() => {}); }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem("pm-view", v); } catch { /* ignore */ } };
  const addPerson = (name: string) => { setPeople((p) => (p.some((x) => x.toLowerCase() === name.toLowerCase()) ? p : [...p, name].sort())); void fetch("/api/project-management/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => {}); };
  const removePerson = (name: string) => { setPeople((p) => p.filter((x) => x !== name)); void fetch(`/api/project-management/people?name=${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {}); };

  const weeks = useMemo(() => { const set = new Set<string>(extraWeeks); for (const t of tasks) if (t.week) set.add(t.week); if (week) set.add(week); return Array.from(set).sort(); }, [tasks, extraWeeks, week]);
  const visible = useMemo(() => (multi && week ? tasks.filter((t) => t.week === week) : tasks), [tasks, multi, week]);
  const weekOpts: Opt[] = [{ value: ALL_WEEK, label: "All time" }, ...weeks.map((w) => ({ value: w, label: weekLabel(w) })), { value: ADD_WEEK, label: "＋ Add a week…" }];
  const onWeekChange = (v: string) => { if (v === ALL_WEEK) setWeek(""); else if (v === ADD_WEEK) { const d = window.prompt("Add a week — enter the call date (YYYY-MM-DD):")?.trim(); if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) { setExtraWeeks((p) => (p.includes(d) ? p : [...p, d])); setWeek(d); } } else setWeek(v); };

  // In weekly mode (group views) stamp new tasks with the selected week.
  const create = (slug: string, f: NewFields) => onCreate(slug, { ...f, week: multi && week ? week : undefined });
  const h: Handlers = { clients, multi, people, addPerson, removePerson, openNew: (stage, clientSlug, assignee) => setEditor({ mode: "new", stage, clientSlug, assignee }), onOpen: (t) => setEditor({ mode: "edit", task: t }), onDrag: setDragId, dragId, onMove, onSetDay };
  const byStage = useMemo(() => { const m: Record<string, BoardTask[]> = {}; for (const s of STAGES) m[s.key] = []; for (const t of visible) (m[t.stage] || m.todo).push(t); return m; }, [visible]);
  const views: [View, string][] = [["kanban", "Kanban"], ...(multi ? [["byclient", "By client"] as [View, string]] : []), ["individuals", "Individuals"], ["table", "Table"], ["swimlanes", "Swimlanes"], ["list", "List"], ["timeline", "Week"], ["pipeline", "Pipeline"]];
  const viewOpts: Opt[] = views.map(([v, label]) => ({ value: v, label }));

  return (
    <>
      <div className="pm-boardbar">
        {multi && <label className="pm-viewdd"><span>When</span><Select value={week || ALL_WEEK} options={weekOpts} onChange={onWeekChange} minWidth={160} /></label>}
        <label className="pm-viewdd"><span>View</span><Select value={view} options={viewOpts} onChange={(v) => pickView(v as View)} minWidth={150} /></label>
      </div>
      {view === "kanban" && <KanbanView byStage={byStage} h={h} />}
      {view === "byclient" && multi && <ByClientView tasks={visible} h={h} />}
      {view === "individuals" && <IndividualsView tasks={visible} h={h} />}
      {view === "table" && <TableView tasks={visible} h={h} onUpdate={onUpdate} onCreate={create} week={multi && week ? week : undefined} people={people} />}
      {view === "swimlanes" && <SwimlanesView tasks={visible} h={h} />}
      {view === "list" && <ListView byStage={byStage} h={h} />}
      {view === "timeline" && <TimelineView tasks={visible} h={h} />}
      {view === "pipeline" && <PipelineView tasks={visible} h={h} />}
      {editor && <TaskEditor state={editor} clients={clients} people={people} multi={multi} addPerson={addPerson} removePerson={removePerson} onClose={() => setEditor(null)} onCreate={create} onUpdate={onUpdate} onDelete={onDelete} />}
    </>
  );
}
