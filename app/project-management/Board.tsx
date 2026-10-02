// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import RichNotes, { plainNotes } from "../components/RichNotes";
import LatestUpdates from "./LatestUpdates";

export type LinkItem = { url: string; title?: string };
export type Blocker = { owner?: string; text?: string; resolved?: boolean; resolvedAt?: string };
export type BoardTask = { id: string; title: string; stage: string; owner: string | null; due_date: string | null; context?: string | null; links?: (string | LinkItem)[]; priority?: string | null; week?: string | null; blocker?: Blocker | Blocker[] | null; source: string; created_at?: string | null; updated_at?: string | null; updated_by?: string | null; position?: number | null; checks?: Checks | null; clientSlug?: string; clientName?: string };
const blockerList = (b?: Blocker | Blocker[] | null): Blocker[] => (Array.isArray(b) ? b : b ? [b] : []).filter((x) => x && (x.text || x.owner));
/** The two checkpoints every campaign needs. */
export type Checks = { list: boolean; messaging: boolean };
export type BoardClient = { slug: string; name: string; logoUrl?: string | null; accentColor?: string | null };
export type Person = { name: string; avatarUrl?: string | null };
type View = "kanban" | "byclient" | "individuals" | "table" | "swimlanes";
type SortKey = "manual" | "priority" | "due" | "status" | "title" | "assignee";
export type NewFields = { title: string; stage: string; assignee?: string; dueDate?: string; context?: string; links?: LinkItem[]; priority?: string; week?: string; checks?: Checks };

const STAGES = [
  { key: "todo", label: "To do", cls: "todo", color: "#6b7280" },
  { key: "planning", label: "Planning", cls: "plan", color: "#8b93a7" },
  { key: "building", label: "Building", cls: "build", color: "#3fb0c9" },
  { key: "in_progress", label: "In progress", cls: "prog", color: "#5aa9f0" },
  { key: "blocked", label: "Blocked", cls: "blocked", color: "#e5484d" },
  { key: "paused", label: "Paused", cls: "pause", color: "#e0a83d" },
  { key: "completed", label: "Completed", cls: "done", color: "#3fb27f" },
  { key: "launched", label: "Launched", cls: "launch", color: "#7c6cf0" },
  { key: "other", label: "Other", cls: "other", color: "#9a8cf0" },
];
const PRIORITIES = [{ key: "p1", label: "Priority 1", color: "#ff2d6f" }, { key: "high", label: "High", color: "#e5484d" }, { key: "medium", label: "Medium", color: "#f2913d" }, { key: "low", label: "Low", color: "#e6c229" }];
const ALL_VIEWS: [View, string][] = [["kanban", "Kanban"], ["byclient", "By client"], ["individuals", "Individuals"], ["table", "Table"], ["swimlanes", "Swimlanes"]];
const stageOf = (k: string) => STAGES.find((x) => x.key === k) ?? STAGES[0];
const prioOf = (k?: string | null) => PRIORITIES.find((x) => x.key === k) ?? null;
const prioRank = (k?: string | null) => { const i = PRIORITIES.findIndex((p) => p.key === k); return i < 0 ? 9 : i; };
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();
const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
const ownerList = (o?: string | null) => (o ? o.split(",").map((s) => s.trim()).filter(Boolean) : []);
const linkItems = (links?: (string | LinkItem)[]): LinkItem[] => (Array.isArray(links) ? links.map((l) => (typeof l === "string" ? { url: l } : l)).filter((l) => l && l.url) : []);
const normUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
const linkLabel = (l: LinkItem) => { if (l.title && l.title.trim()) return l.title.trim(); try { const x = new URL(l.url); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, ""); } catch { return l.url; } };
const dueMs = (v?: string | null) => { if (!v) return Infinity; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00" : v); return Number.isNaN(+d) ? Infinity : +d; };
export const weekDisplay = (w?: string | null) => (!w ? "" : `Starts ${w.replace(/^week of\s*/i, "")}`);
/* When a task was created, spelled out in Eastern time — e.g. "Sep 8, 2026, 3:42 PM EST". */
const fmtEst = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso); if (Number.isNaN(+d)) return "";
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
};
/* Date + time in EST for the Dates column — "9/3 @ 8:00 AM". */
const fmtDateAt = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso); if (Number.isNaN(+d)) return "";
  const date = d.toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric" });
  const time = d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return `${date} @ ${time}`;
};
/* How long a task has been sitting since it was added — compact ("3d", "5h", "just now"). */
const sittingFor = (iso?: string | null): string => {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso); if (Number.isNaN(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};
/**
 * How worrying a task's age is, from when it was added: fine for a week, then amber, orange and red.
 * Finished tasks are never flagged; they are done, not sitting.
 */
const ageTone = (iso?: string | null, stage?: string): "" | "warn" | "late" | "stale" => {
  if (!iso || stage === "completed" || stage === "launched") return "";
  const days = (Date.now() - Date.parse(iso)) / 86_400_000;
  if (!Number.isFinite(days)) return "";
  return days >= 30 ? "stale" : days >= 14 ? "late" : days >= 7 ? "warn" : "";
};
const ageNote = { "": "", warn: "Sitting over a week", late: "Sitting over two weeks, take a look", stale: "Sitting over a month, overdue" } as const;
function sortTasks(list: BoardTask[], key: SortKey): BoardTask[] {
  if (key === "manual") return list;
  const arr = [...list];
  arr.sort((a, b) => {
    if (key === "priority") return prioRank(a.priority) - prioRank(b.priority);
    if (key === "due") return dueMs(a.due_date) - dueMs(b.due_date);
    if (key === "status") return STAGES.findIndex((s) => s.key === a.stage) - STAGES.findIndex((s) => s.key === b.stage);
    if (key === "title") return a.title.localeCompare(b.title);
    if (key === "assignee") return (ownerList(a.owner)[0] || "￿").localeCompare(ownerList(b.owner)[0] || "￿");
    return 0;
  });
  return arr;
}

/* ══ Reusable custom dropdown primitives (no native <select>) ══ */
type Opt = { value: string; label: string; logo?: React.ReactNode; color?: string };
function Chevron() { return <svg className="pm-chev" viewBox="0 0 10 6" width="8" height="5" aria-hidden><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function useMenu(minW = 0) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const place = () => { const r = btnRef.current?.getBoundingClientRect(); if (!r) return; const width = Math.max(r.width, minW); const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 10)); setPos({ top: r.bottom + 5, left, width }); };
  const toggle = () => { if (pos) setPos(null); else place(); };
  const close = () => setPos(null);
  useEffect(() => {
    if (!pos) return;
    // Close when the page behind the menu scrolls (the menu is fixed-positioned under the button, so it would
    // otherwise detach and float). But the menu itself scrolls when the roster is long, and that scroll is
    // caught here in the capture phase too — closing on it made a long people list impossible to scroll. So a
    // scroll whose target is inside the open menu is ignored; only scrolling the content behind it dismisses.
    const onScroll = (e: Event) => { const t = e.target; if (t instanceof Element && t.closest(".pm-dd-menu")) return; setPos(null); };
    const onResize = () => setPos(null);
    window.addEventListener("scroll", onScroll, true); window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onResize); };
  }, [pos]);
  return { btnRef, pos, open: !!pos, toggle, close };
}
function Select({ value, options, onChange, placeholder, minWidth, tone, size }: { value: string; options: Opt[]; onChange: (v: string) => void; placeholder?: string; minWidth?: number; tone?: string; size?: "lg" }) {
  const m = useMenu(minWidth ?? 150);
  const cur = options.find((o) => o.value === value);
  return (
    <div className={`pm-dd ${size === "lg" ? "pm-dd-lg" : ""}`}>
      <button ref={m.btnRef} type="button" className="pm-dd-btn" style={tone ? { color: tone } : undefined} onClick={(e) => { e.stopPropagation(); m.toggle(); }}>
        <span className="pm-dd-val">{cur ? <>{cur.logo}{cur.color && <i className="pm-dd-dot" style={{ background: cur.color }} />}{cur.label}</> : <span className="pm-dd-ph">{placeholder ?? "—"}</span>}</span><Chevron />
      </button>
      {m.open && m.pos && <>
        <div className="pm-dd-back" onClick={(e) => { e.preventDefault(); e.stopPropagation(); m.close(); }} />
        <div className={`pm-dd-menu ${size === "lg" ? "pm-dd-menu-lg" : ""}`} style={{ top: m.pos.top, left: m.pos.left, minWidth: m.pos.width }}>
          {options.map((o) => <button key={o.value} type="button" className={`pm-dd-opt ${o.value === value ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); onChange(o.value); m.close(); }}>{o.logo}{o.color && <i className="pm-dd-dot" style={{ background: o.color }} />}<span className="pm-dd-opt-l">{o.label}</span>{o.value === value && <span className="pm-dd-ck">✓</span>}</button>)}
        </div>
      </>}
    </div>
  );
}
function Avatar({ name, map, cls }: { name: string; map: Record<string, string>; cls?: string }) {
  const url = map[name];
  return <span className={`pm-av ${cls || ""}`} style={url ? undefined : { background: `hsl(${hue(name)} 55% 45%)` }}>{url ? <img src={url} alt="" /> : initials(name)}</span>;
}
function Owners({ owner, map, stack }: { owner?: string | null; map: Record<string, string>; stack?: boolean }) {
  const list = ownerList(owner); if (!list.length) return null;
  if (list.length <= 2) return <span className={`pm-own-inline ${stack ? "stack" : ""}`}>{list.map((n) => <span className="pm-own-chip" key={n}><Avatar name={n} map={map} />{n}</span>)}</span>;
  return <span className="pm-av-row">{list.slice(0, 3).map((n) => <Avatar key={n} name={n} map={map} />)}<span className="pm-av-names">{list.length} people</span></span>;
}
function MultiPeople({ value, people, map, onChange, addPerson, removePerson, uploadAvatar, placeholder = "Unassigned", stack }: { value: string; people: Person[]; map: Record<string, string>; onChange: (v: string) => void; addPerson: (n: string) => void; removePerson: (n: string) => void; uploadAvatar: (n: string, f: File) => void; placeholder?: string; stack?: boolean }) {
  const m = useMenu(230); const sel = ownerList(value); const [draft, setDraft] = useState("");
  const toggle = (name: string) => { const next = sel.includes(name) ? sel.filter((x) => x !== name) : [...sel, name]; onChange(next.join(", ")); };
  const add = () => { const n = draft.trim(); if (!n) return; addPerson(n); if (!sel.includes(n)) onChange([...sel, n].join(", ")); setDraft(""); };
  const roster = Array.from(new Set([...people.map((p) => p.name), ...sel]));
  return (
    <div className="pm-dd">
      <button ref={m.btnRef} type="button" className="pm-dd-btn" onClick={(e) => { e.stopPropagation(); m.toggle(); }}>
        <span className={`pm-dd-val ${stack ? "stack" : ""}`}>{sel.length ? <Owners owner={value} map={map} stack={stack} /> : <span className="pm-dd-ph">{placeholder}</span>}</span><Chevron />
      </button>
      {m.open && m.pos && <>
        <div className="pm-dd-back" onClick={(e) => { e.preventDefault(); e.stopPropagation(); m.close(); }} />
        <div className="pm-dd-menu" style={{ top: m.pos.top, left: m.pos.left, minWidth: m.pos.width }} onClick={(e) => e.stopPropagation()}>
          {sel.length > 0 && <div className="pm-sel-chips">{sel.map((n) => <span className="pm-sel-chip" key={n}><Avatar name={n} map={map} />{n}<button type="button" title="Remove from this task" onClick={() => toggle(n)}>✕</button></span>)}</div>}
          {roster.map((p) => (
            <div className={`pm-dd-opt multi ${sel.includes(p) ? "on" : ""}`} key={p}>
              <button type="button" className="pm-dd-optmain" onClick={() => toggle(p)}><span className={`pm-check ${sel.includes(p) ? "on" : ""}`}>{sel.includes(p) ? "✓" : ""}</span><Avatar name={p} map={map} /><span className="pm-dd-opt-l">{p}</span></button>
              <label className="pm-dd-photo" title="Upload photo"><svg viewBox="0 0 20 20" width="13" height="13"><path fill="currentColor" d="M4 5h3l1-2h4l1 2h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm6 3a3 3 0 100 6 3 3 0 000-6z" /></svg><input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(p, f); }} /></label>
              <button type="button" className="pm-dd-rm" title="Delete from the whole roster" onClick={() => removePerson(p)}>🗑</button>
            </div>
          ))}
          <div className="pm-dd-add"><input value={draft} placeholder="Add a person…" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /><button type="button" onClick={add}>Add</button></div>
        </div>
      </>}
    </div>
  );
}
function FiltersPanel({ view, views, onPickView, onReorderViews, sort, onSort, multi, week, weeks, onPickWeek, onAddWeek, onRemoveWeek }: {
  view: View; views: [View, string][]; onPickView: (v: View) => void; onReorderViews: (keys: View[]) => void;
  sort: SortKey; onSort: (s: SortKey) => void; multi: boolean; week: string; weeks: string[]; onPickWeek: (w: string) => void; onAddWeek: (label: string) => void; onRemoveWeek: (label: string) => void;
}) {
  const m = useMenu(multi ? 660 : 420); const [drag, setDrag] = useState<View | null>(null); const [draft, setDraft] = useState("");
  const drop = (target: View) => { if (!drag || drag === target) return; const keys = views.map(([v]) => v); const from = keys.indexOf(drag), to = keys.indexOf(target); keys.splice(to, 0, keys.splice(from, 1)[0]); onReorderViews(keys); setDrag(null); };
  const add = () => { const n = draft.trim(); if (!n) return; onAddWeek(n); setDraft(""); };
  const curView = views.find(([v]) => v === view);
  return (
    <div className="pm-dd">
      <button ref={m.btnRef} type="button" className="pm-dd-btn pm-filt-btn" onClick={(e) => { e.stopPropagation(); m.toggle(); }}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><path fill="currentColor" d="M1 3h14l-5.4 6.3V15L6.4 13V9.3z" /></svg>
        <span className="pm-dd-val">{curView ? curView[1] : "Filters"}{multi && week ? ` · ${weekDisplay(week)}` : ""}</span><Chevron />
      </button>
      {m.open && m.pos && <>
        <div className="pm-dd-back" onClick={(e) => { e.preventDefault(); e.stopPropagation(); m.close(); }} />
        <div className="pm-dd-menu pm-filters" style={{ top: m.pos.top, left: m.pos.left, width: m.pos.width }} onClick={(e) => e.stopPropagation()}>
          <div className="pm-filt-sec">
            <div className="pm-filt-h">View <em>· drag to reorder</em></div>
            {views.map(([v, label]) => (
              <div key={v} className={`pm-dd-opt multi ${v === view ? "on" : ""} ${drag === v ? "dragging" : ""}`} draggable onDragStart={() => setDrag(v)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(v)}>
                <span className="pm-vgrip" title="Drag to reorder">⠿</span>
                <button type="button" className="pm-dd-optmain" onClick={() => onPickView(v)}><span className="pm-dd-opt-l">{label}</span>{v === view && <span className="pm-dd-ck">✓</span>}</button>
              </div>
            ))}
          </div>
          {multi && (
            <div className="pm-filt-sec">
              <div className="pm-filt-h">Start date</div>
              <button type="button" className={`pm-dd-opt ${!week ? "on" : ""}`} onClick={() => onPickWeek("")}><span className="pm-dd-opt-l">All time</span>{!week && <span className="pm-dd-ck">✓</span>}</button>
              {weeks.map((w) => (
                <div className={`pm-dd-opt multi ${w === week ? "on" : ""}`} key={w}>
                  <button type="button" className="pm-dd-optmain" onClick={() => onPickWeek(w)}><span className="pm-dd-opt-l">{weekDisplay(w)}</span>{w === week && <span className="pm-dd-ck">✓</span>}</button>
                  <button type="button" className="pm-dd-rm" title="Remove week" onClick={() => onRemoveWeek(w)}>✕</button>
                </div>
              ))}
              <div className="pm-dd-add"><input value={draft} placeholder="New start date, e.g. Sept 3" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /><button type="button" onClick={add}>Add</button></div>
            </div>
          )}
          <div className="pm-filt-sec">
            <div className="pm-filt-h">Sort by</div>
            {SORTS.map(([v, l]) => <button key={v} type="button" className={`pm-dd-opt ${v === sort ? "on" : ""}`} onClick={() => onSort(v)}><span className="pm-dd-opt-l">{l}</span>{v === sort && <span className="pm-dd-ck">✓</span>}</button>)}
          </div>
        </div>
      </>}
    </div>
  );
}

type EditorState = { mode: "new"; stage: string; clientSlug?: string; assignee?: string } | { mode: "edit"; task: BoardTask } | null;
type Handlers = {
  clients: BoardClient[]; multi: boolean; people: Person[]; map: Record<string, string>; addPerson: (n: string) => void; removePerson: (n: string) => void; uploadAvatar: (n: string, f: File) => void;
  openNew: (stage: string, clientSlug?: string, assignee?: string) => void; onOpen: (t: BoardTask) => void; onDelete: (id: string) => void; notifyChannel?: string;
  onDrag: (id: string | null, height?: number) => void; dragId: string | null; dragH: number; landedId: string | null; onMove: (id: string, stage: string) => void; onSetDay: (id: string, date: string) => void;
  /** Drop the dragged task before (or after) `targetId` within the list `ids`, i.e. reorder that column. */
  onReorder: (ids: string[], targetId: string, after: boolean, movingId?: string) => void;
  dropHint: { id: string; after: boolean } | null; setDropHint: (h: { id: string; after: boolean } | null) => void;
  /** In the By client view the column header already names the client. */
  hideClient?: boolean;
};
function clientLogo(c: BoardClient) { return c.logoUrl ? <img className="pm-opt-logo" src={c.logoUrl} alt="" /> : <span className="pm-opt-logo mono" style={{ background: c.accentColor || "var(--accent)" }}>{initials(c.name)}</span>; }
const clientOptsOf = (clients: BoardClient[]): Opt[] => clients.map((c) => ({ value: c.slug, label: c.name, logo: clientLogo(c) }));
const stageOpts: Opt[] = STAGES.map((s) => ({ value: s.key, label: s.label, color: s.color }));
const prioOpts: Opt[] = [{ value: "", label: "None" }, ...PRIORITIES.map((p) => ({ value: p.key, label: p.label, color: p.color }))];

/**
 * Where the dragged card would land in a column, as an index into the column without the dragged card,
 * or -1 when nothing is being dragged within this column.
 */
/**
 * The card being dragged, recorded the instant the drag starts. React state is updated a tick later (so the
 * drag image is captured first), and a quick drag can be over before that state lands; drop decisions read
 * this instead so they never depend on timing.
 */
const activeDrag: { id: string | null } = { id: null };
const draggingId = (h: Handlers) => activeDrag.id ?? h.dragId;

function insertionIndex(column: string[] | undefined, h: Handlers): number {
  const id = draggingId(h);
  if (!column || !id || !column.includes(id) || !h.dropHint) return -1;
  const rest = column.filter((x) => x !== id);
  const at = rest.indexOf(h.dropHint.id);
  return at < 0 ? -1 : at + (h.dropHint.after ? 1 : 0);
}
/** A picked-up copy of the card for the drag image: slightly larger and tilted, with a lifted shadow. */
function liftedDragImage(e: React.DragEvent<HTMLElement>) {
  const node = e.currentTarget;
  const rect = node.getBoundingClientRect();
  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;top:-2000px;left:-2000px;padding:24px;width:${rect.width + 48}px;pointer-events:none;`;
  const ghost = node.cloneNode(true) as HTMLElement;
  ghost.classList.add("pm-bcard-ghost");
  ghost.style.width = `${rect.width}px`;
  wrap.appendChild(ghost);
  document.body.appendChild(wrap);
  try { e.dataTransfer.setDragImage(wrap, e.clientX - rect.left + 24, e.clientY - rect.top + 24); } catch { /* older browsers keep the default image */ }
  window.setTimeout(() => wrap.remove(), 0);
}
/**
 * How far a card should slide while another card in its column is dragged: up one slot if the dragged
 * card is passing it on the way down, down one slot if it is passing it on the way up, otherwise 0.
 * The dragged card keeps its own slot (only made invisible): Chrome cancels a drag if the source element
 * shrinks or stops taking pointer events while the drag is starting.
 */
function slideFor(column: string[], id: string, h: Handlers): -1 | 0 | 1 {
  const at = insertionIndex(column, h);
  if (at < 0 || id === h.dragId) return 0;
  const src = column.indexOf(draggingId(h) as string);
  const i = column.indexOf(id);
  if (i < src) return i >= at ? 1 : 0; // dragged card moving up past it: it moves down
  return i - 1 < at ? -1 : 0; // dragged card moving down past it: it moves up into the freed slot
}
/**
 * Lets the whole column accept the drop, not just the cards. When the cards spring apart, the natural
 * place to let go is the gap that opened, which is the column itself; without this the browser treated
 * that release as a cancelled drag and nothing moved.
 */
function columnDropProps(column: string[], h: Handlers, fallback?: () => void) {
  return {
    onDragOver: (e: React.DragEvent) => { const id = draggingId(h); if (id && (column.includes(id) || fallback)) e.preventDefault(); },
    onDrop: (e: React.DragEvent) => {
      const id = draggingId(h);
      if (!id) return;
      e.preventDefault();
      if (column.includes(id) && h.dropHint && column.includes(h.dropHint.id)) h.onReorder(column, h.dropHint.id, h.dropHint.after, id);
      else if (column.includes(id)) { activeDrag.id = null; h.onDrag(null); h.setDropHint(null); }
      else fallback?.();
    },
  };
}
function Card({ t, h, column, slide = 0 }: { t: BoardTask; h: Handlers; column?: string[]; slide?: -1 | 0 | 1 }) {
  const s = stageOf(t.stage);
  const pr = prioOf(t.priority);
  const client = h.clients.find((c) => c.slug === t.clientSlug);
  const owners = ownerList(t.owner);
  const openBlockers = blockerList(t.blocker).filter((b) => !b.resolved);
  return (
    <div
      className={`pm-bcard ${t.priority === "p1" ? "pm-bcard-p1" : ""} ${h.dragId === t.id ? "pm-bcard-source" : ""} ${slide ? "pm-bcard-shift" : ""} ${h.landedId === t.id ? "pm-bcard-landed" : ""}`}
      style={slide ? ({ translate: `0 ${slide * (h.dragH + 10)}px` } as React.CSSProperties) : undefined}
      data-shift={slide * (h.dragH + 10)}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("id", t.id); liftedDragImage(e); activeDrag.id = t.id; const height = e.currentTarget.getBoundingClientRect().height; window.setTimeout(() => h.onDrag(t.id, height), 0); }}
      onDragEnd={() => { activeDrag.id = null; h.onDrag(null); h.setDropHint(null); }}
      onDragOver={column ? (e) => {
        const id = draggingId(h);
        if (!id || id === t.id || !column.includes(id)) return;
        e.preventDefault(); e.stopPropagation();
        // Measured where the card sits without its spring shift, so opening the gap can't flip the answer.
        const r = e.currentTarget.getBoundingClientRect();
        const top = r.top - Number(e.currentTarget.dataset.shift || 0);
        const after = e.clientY > top + r.height / 2;
        if (h.dropHint?.id !== t.id || h.dropHint.after !== after) h.setDropHint({ id: t.id, after });
      } : undefined}
      onDrop={column ? (e) => {
        const id = draggingId(h);
        if (!id || id === t.id || !column.includes(id)) return;
        e.preventDefault(); e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > r.top - Number(e.currentTarget.dataset.shift || 0) + r.height / 2;
        h.onReorder(column, t.id, after, id);
      } : undefined}
      onClick={() => h.onOpen(t)}
    >
      <span className="pm-bcard-stripe" style={{ background: pr ? pr.color : "var(--border-soft, var(--border))" }} />
      <div className={`pm-bcard-band ${s.cls}`}>
        <span>{s.label}</span>
        {pr && <span className="pm-bcard-prio" style={{ color: pr.color }}>● {pr.label}</span>}
      </div>
      <div className="pm-bcard-body">
        <div className="pm-bcard-title">{t.source !== "manual" && <span className="pm-auto">✦</span>}{t.title}</div>
        {t.context && <div className="pm-bcard-ctx">{plainNotes(t.context)}</div>}
        {(t.checks?.list || t.checks?.messaging) && (
          <div className="pm-bcard-checks">
            <span className={t.checks?.list ? "on" : ""}>{t.checks?.list ? "✓" : "○"} Contact list</span>
            <span className={t.checks?.messaging ? "on" : ""}>{t.checks?.messaging ? "✓" : "○"} Messaging</span>
          </div>
        )}
        {openBlockers.length > 0 && <div className="pm-bcard-block" title={openBlockers.map((b) => `${b.owner || "someone"}: ${b.text}`).join("\n")}>⛔ Waiting on {openBlockers[0].owner ? `${openBlockers[0].owner}${openBlockers[0].text ? ` · ${openBlockers[0].text}` : ""}` : openBlockers[0].text || "someone"}{openBlockers.length > 1 ? ` +${openBlockers.length - 1} more` : ""}</div>}
        <div className="pm-bcard-foot">
          {client && !h.hideClient && <span className="pm-bcard-client"><span className="pm-bcard-clogo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>{client.logoUrl ? <img src={client.logoUrl} alt="" /> : initials(client.name)}</span>{client.name}</span>}
          {owners.length > 0 && (h.hideClient && owners.length <= 2
            ? owners.map((o) => <span className="pm-bcard-owner" key={o}><Avatar name={o} map={h.map} />{o}</span>)
            : <span className="pm-bcard-owner"><Avatar name={owners[0]} map={h.map} />{owners.length === 1 ? owners[0] : `${owners.length} people`}</span>)}
          {t.created_at && (() => { const tone = ageTone(t.created_at, t.stage); return <span className={`pm-bcard-age ${tone ? `pm-age-${tone}` : ""}`} title={`Added ${fmtEst(t.created_at)}${tone ? ` · ${ageNote[tone]}` : ""}`}>⏱ {sittingFor(t.created_at)}</span>; })()}
          {t.week && !t.due_date && <span className="pm-bcard-due" title="Start date">Starts {t.week}</span>}
          {t.due_date && <span className="pm-bcard-due" title={t.week ? `Starts ${t.week} · due ${t.due_date}` : "Due date"}>{t.due_date}</span>}
        </div>
      </div>
    </div>
  );
}

function KanbanView({ byStage, h }: { byStage: Record<string, BoardTask[]>; h: Handlers }) {
  return (
    <div className="pm-kb">
      {STAGES.map((s) => (
        <div className="pm-col" key={s.key} {...columnDropProps(byStage[s.key].map((x) => x.id), h, () => { const id = draggingId(h); activeDrag.id = null; if (id) h.onMove(id, s.key); })}>
          <div className="pm-colh"><span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span></div>
          {(() => { const ids = byStage[s.key].map((x) => x.id); return byStage[s.key].map((t) => <Card key={t.id} t={t} h={h} column={ids} slide={slideFor(ids, t.id, h)} />); })()}
          {s.key === "todo" && <button type="button" className="pm-add" onClick={() => h.openNew("todo")}>+ Add</button>}
        </div>
      ))}
    </div>
  );
}
type Peek = { connected: boolean; at?: string; total?: { pending: number; senders: number; daysLeft: number | null }; campaigns: Array<{ name: string; pending: number; senders: string[]; senderCount: number; daysLeft: number | null; paused?: boolean }> };
const peekCache = new Map<string, { at: number; data?: Peek; error?: string }>();
/**
 * The HeyReach mark on a client's column header. Hover it and HeyReach is asked, on the spot, for that
 * client's active campaigns, their senders, leads pending and days of sending left; move away and the
 * card goes. Answers are reused for two minutes so sweeping across the headers doesn't re-ask each time.
 */
function HeyReachPeek({ slug, name }: { slug: string; name: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [state, setState] = useState<{ data?: Peek; error?: string; loading: boolean }>({ loading: false });
  const [logoOk, setLogoOk] = useState(true);
  // Belt and braces for touch screens and overlays: any scroll or click elsewhere closes the card.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e.target instanceof Node && ref.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener("scroll", close, true); window.addEventListener("pointerdown", close, true);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("pointerdown", close, true); };
  }, [open]);
  const show = () => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    const width = 340;
    const left = r.right + 10 + width > window.innerWidth ? Math.max(8, r.left - width - 10) : r.right + 10;
    setPos({ top: Math.max(8, Math.min(r.top - 8, window.innerHeight - 420)), left });
    setOpen(true);
    const hit = peekCache.get(slug);
    if (hit && Date.now() - hit.at < 120_000) { setState({ data: hit.data, error: hit.error, loading: false }); return; }
    setState({ loading: true });
    void fetch(`/api/project-management/heyreach?client=${encodeURIComponent(slug)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((p) => { const entry = p.ok ? { at: Date.now(), data: p as Peek } : { at: Date.now(), error: String(p.error || "HeyReach could not be reached.") }; peekCache.set(slug, entry); setState({ data: entry.data, error: entry.error, loading: false }); })
      .catch(() => setState({ error: "HeyReach could not be reached.", loading: false }));
  };
  const d = state.data;
  const card = open && pos ? (
    <div className="pm-peek" style={{ top: pos.top, left: pos.left }} role="tooltip">
      <div className="pm-peek-head"><b>{name}</b><span>{state.loading ? "Asking HeyReach…" : d?.at ? `Live · ${new Date(d.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span></div>
      {state.loading ? <div className="pm-peek-load"><span className="rr-skel-bar" style={{ width: "80%", height: 10 }} /><span className="rr-skel-bar" style={{ width: "60%", height: 10 }} /><span className="rr-skel-bar" style={{ width: "70%", height: 10 }} /></div>
        : state.error ? <p className="pm-peek-empty">{state.error}</p>
        : !d?.connected ? <p className="pm-peek-empty">No HeyReach key is set for this client.</p>
        : !d.campaigns.length ? <p className="pm-peek-empty">No active campaigns right now.</p>
        : <>
          <div className="pm-peek-total">
            <div><strong>{d.total?.pending.toLocaleString()}</strong><small>leads pending</small></div>
            <div className={d.total?.daysLeft != null && d.total.daysLeft <= 3 ? "warn" : ""}><strong>{d.total?.daysLeft ?? "–"}</strong><small>days of sending left</small></div>
          </div>
          <div className="pm-peek-list">
            {d.campaigns.map((c) => (
              <div className="pm-peek-row" key={c.name}>
                <div className="pm-peek-name">{c.name}{c.paused && <span className="pm-peek-tag" title="HeyReach's API reports this campaign as paused. It still has leads left.">Paused in HeyReach</span>}</div>
                <div className="pm-peek-meta">
                  <span>{c.pending.toLocaleString()} pending</span>
                  <span className={c.daysLeft != null && c.daysLeft <= 3 ? "warn" : ""}>{c.daysLeft == null ? "no senders" : `${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"} left`}</span>
                </div>
                <div className="pm-peek-senders">{c.senders.length ? c.senders.join(", ") : `${c.senderCount} sender${c.senderCount === 1 ? "" : "s"}`}</div>
              </div>
            ))}
          </div>
        </>}
    </div>
  ) : null;
  return (
    <>
      <button ref={ref} type="button" className="pm-peek-btn" aria-label={`Live HeyReach stats for ${name}`} onMouseEnter={show} onMouseLeave={() => setOpen(false)} onFocus={show} onBlur={() => setOpen(false)} onClick={(e) => { e.stopPropagation(); if (open) setOpen(false); else show(); }}>
        {logoOk ? <img src="https://www.google.com/s2/favicons?domain=heyreach.io&sz=64" alt="" onError={() => setLogoOk(false)} /> : <span>HR</span>}
      </button>
      {typeof document !== "undefined" && card ? createPortal(card, document.body) : null}
    </>
  );
}

function ColumnList({ label, logo, tasks, onAdd, h, reorderable, extra }: { label: React.ReactNode; logo?: React.ReactNode; tasks: BoardTask[]; onAdd: () => void; h: Handlers; reorderable?: boolean; extra?: React.ReactNode }) {
  const ids = tasks.map((t) => t.id);
  return (
    <div className="pm-col" {...(reorderable ? columnDropProps(ids, h) : {})}>
      <div className="pm-colh pm-colh-big">{logo}<b>{label}</b>{extra}</div>
      {tasks.map((t) => <Card key={t.id} t={t} h={h} column={reorderable ? ids : undefined} slide={reorderable ? slideFor(ids, t.id, h) : 0} />)}
      <button type="button" className="pm-add" onClick={onAdd}>+ Add</button>
    </div>
  );
}
function ByClientView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  return (
    <div className="pm-cols pm-cols-byclient" style={{ gridTemplateColumns: `repeat(${Math.max(1, h.clients.length)}, minmax(340px, 1fr))` }}>
      {h.clients.map((c) => (
        <ColumnList reorderable key={c.slug} extra={<HeyReachPeek slug={c.slug} name={c.name} />} label={c.name} logo={<span className="pm-bighead-logo" style={c.logoUrl ? undefined : { background: c.accentColor || "var(--accent)" }}>{c.logoUrl ? <img src={c.logoUrl} alt="" /> : initials(c.name)}</span>} tasks={tasks.filter((t) => t.clientSlug === c.slug)} onAdd={() => h.openNew("todo", c.slug)} h={{ ...h, hideClient: true }} />
      ))}
    </div>
  );
}
function IndividualsView({ tasks, h }: { tasks: BoardTask[]; h: Handlers }) {
  const owners = useMemo(() => { const set = new Set<string>(h.people.map((p) => p.name)); for (const t of tasks) for (const o of ownerList(t.owner)) set.add(o); const arr = Array.from(set); arr.push("Unassigned"); return arr; }, [tasks, h.people]);
  return (
    <div className="pm-cols" style={{ gridTemplateColumns: `repeat(${Math.max(1, owners.length)}, minmax(300px, 1fr))` }}>
      {owners.map((o) => (
        <ColumnList key={o} label={o} logo={o === "Unassigned" ? <span className="pm-bighead-logo" style={{ background: "var(--muted-2,#555)" }}>?</span> : <Avatar name={o} map={h.map} cls="pm-av-lg" />} tasks={tasks.filter((t) => { const l = ownerList(t.owner); return o === "Unassigned" ? l.length === 0 : l.includes(o); })} onAdd={() => h.openNew("todo", h.multi ? undefined : h.clients[0]?.slug, o === "Unassigned" ? "" : o)} h={h} />
      ))}
    </div>
  );
}

/* ── Auto-growing textarea for the Context cell ── */
function AutoTextarea({ defaultValue, placeholder, onCommit, className = "" }: { defaultValue: string; placeholder?: string; onCommit: (v: string) => void; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
  useEffect(() => {
    const el = ref.current; if (!el) return;
    fit(el);
    // Refit when the column's width changes (window resize, layout settling) so a long paragraph
    // grows the row instead of clipping. Guarded on width so setting height can't loop the observer.
    let lastW = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== lastW) { lastW = el.clientWidth; fit(el); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <textarea ref={ref} className={`pm-cellin pm-cellarea ${className}`} rows={1} defaultValue={defaultValue} placeholder={placeholder} onInput={(e) => fit(e.currentTarget)} onBlur={(e) => onCommit(e.currentTarget.value)} />;
}
/* ── Links cell (table) — titled links in a popover ── */
function LinksCell({ links, onChange }: { links: LinkItem[]; onChange: (l: LinkItem[]) => void }) {
  const m = useMenu(280); const [url, setUrl] = useState(""); const [title, setTitle] = useState("");
  const add = () => { const u = url.trim(); if (!u) return; onChange([...links, { url: normUrl(u), title: title.trim() || undefined }]); setUrl(""); setTitle(""); };
  return (
    <div className="pm-dd pm-linkscell">
      <button ref={m.btnRef} type="button" className={`pm-linkstrigger ${links.length ? "" : "empty"}`} title={links.length ? `${links.length} link${links.length > 1 ? "s" : ""}` : "Add link"} onClick={(e) => { e.stopPropagation(); m.toggle(); }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
        {links.length ? <span className="pm-linkcount">{links.length}</span> : null}<Chevron />
      </button>
      {m.open && m.pos && <>
        <div className="pm-dd-back" onClick={(e) => { e.preventDefault(); e.stopPropagation(); m.close(); }} />
        <div className="pm-dd-menu pm-linkmenu" style={{ top: m.pos.top, left: m.pos.left, minWidth: Math.max(m.pos.width, 280) }} onClick={(e) => e.stopPropagation()}>
          {links.map((l, i) => <div className="pm-linkrow" key={i}><a href={l.url} target="_blank" rel="noreferrer">{linkLabel(l)}</a><button type="button" onClick={() => onChange(links.filter((_, j) => j !== i))}>✕</button></div>)}
          <div className="pm-linkadd">
            <input value={title} placeholder="Title (optional)" onChange={(e) => setTitle(e.target.value)} />
            <div className="pm-linkadd-row"><input value={url} placeholder="Paste a URL…" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /><button type="button" onClick={add}>Add</button></div>
          </div>
        </div>
      </>}
    </div>
  );
}

const slackIcon = (
  <svg width="14" height="14" viewBox="0 0 127 127" fill="currentColor" aria-hidden><path d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80z" /><path d="M33.8 80c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z" /><path d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47z" /><path d="M47 33.6c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H14C6.7 60 .8 54.1.8 46.8c0-7.3 5.9-13.2 13.2-13.2h33z" /><path d="M99.8 46.8c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.8V46.8z" /><path d="M93.2 46.8c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2v-33C66.8 6.5 72.7.6 80 .6c7.3 0 13.2 5.9 13.2 13.2v33z" /><path d="M80 99.6c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.6H80z" /><path d="M80 93c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80z" /></svg>
);
/* The Dates cell — when the task was added and when it was last updated (EST), and who updated it. */
function DatesCell({ created, updated, by, map }: { created?: string | null; updated?: string | null; by?: string | null; map: Record<string, string> }) {
  const who = (by || "").trim();
  return (
    <div className="pm-dates">
      <div className="pm-dates-row" title={created ? `Added ${fmtEst(created)} · sitting ${sittingFor(created)}` : ""}>
        <span className="pm-dates-lbl">Added</span><span className="pm-dates-val">{fmtDateAt(created) || "—"}</span>
      </div>
      <div className="pm-dates-row" title={updated ? (who ? `Updated ${fmtEst(updated)} · by ${who}` : `Updated ${fmtEst(updated)}`) : ""}>
        <span className="pm-dates-lbl">Updated</span><span className="pm-dates-val">{fmtDateAt(updated) || "—"}</span>
        {who ? <Avatar name={who} map={map} cls="pm-dates-av" /> : null}
      </div>
    </div>
  );
}

function SlackButton({ id, channel }: { id: string; channel?: string }) {
  const [st, setSt] = useState<"idle" | "sending" | "sent" | "err">("idle");
  const [msg, setMsg] = useState("");
  const disabled = id.startsWith("tmp");
  const send = async () => {
    if (disabled || st === "sending") return;
    setSt("sending");
    const r = await fetch("/api/project-management/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...(channel ? { channel } : {}) }) }).then((x) => x.json()).catch(() => ({ ok: false, error: "Network error" }));
    if (r.ok) { setSt("sent"); setTimeout(() => setSt("idle"), 2500); } else { setSt("err"); setMsg(String(r.error || "Failed to send")); setTimeout(() => setSt("idle"), 5000); }
  };
  return <button type="button" className={`pm-slackbtn ${st}`} disabled={disabled} title={disabled ? "Save the task first" : st === "err" ? msg : st === "sent" ? "Sent to Slack" : "Send this status to the client's internal Slack channel"} onClick={send}>{st === "sent" ? <span className="pm-slack-ok">✓</span> : st === "err" ? <span className="pm-slack-err">!</span> : st === "sending" ? <span className="pm-slack-load">·</span> : slackIcon}</button>;
}

function nowIso() { return new Date().toISOString(); }
function BlockerCell({ blockers, people, map, onChange, addPerson }: { blockers?: Blocker | Blocker[] | null; people: Person[]; map: Record<string, string>; onChange: (b: Blocker[]) => void; addPerson: (n: string) => void }) {
  const m = useMenu(300);
  const list = blockerList(blockers);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [owner, setOwner] = useState("");
  const [txt, setTxt] = useState("");
  const [draftName, setDraftName] = useState("");
  const openEditor = (target: number | "new") => { const b = target === "new" ? {} : (list[target] || {}); setOwner(b.owner || ""); setTxt(b.text || ""); setDraftName(""); setEditing(target); if (!m.pos) m.toggle(); };
  const closeEditor = () => { setEditing(null); m.close(); };
  const commit = () => {
    const t = txt.trim();
    if (!t && !owner) { if (typeof editing === "number") onChange(list.filter((_, j) => j !== editing)); closeEditor(); return; }
    const prev = typeof editing === "number" ? list[editing] : undefined;
    const blk: Blocker = { owner: owner || "", text: t, resolved: prev?.resolved || false, ...(prev?.resolvedAt ? { resolvedAt: prev.resolvedAt } : {}) };
    onChange(editing === "new" ? [...list, blk] : list.map((b, j) => (j === editing ? blk : b)));
    closeEditor();
  };
  const toggleAt = (i: number) => { const b = list[i]; onChange(list.map((x, j) => (j === i ? { ...b, resolved: !b.resolved, ...(!b.resolved ? { resolvedAt: nowIso() } : {}) } : x))); };
  const addInline = () => { const n = draftName.trim(); if (n) { addPerson(n); setOwner(n); setDraftName(""); } };
  const roster: Opt[] = [{ value: "", label: "Anyone" }, ...people.map((p) => ({ value: p.name, label: p.name, logo: <Avatar name={p.name} map={map} /> }))];
  return (
    <div className="pm-dd pm-blockercell">
      <div className="pm-blocker-list">
        {list.map((b, i) => (
          <div className={`pm-blocker-row ${b.resolved ? "done" : ""}`} key={i}>
            <button type="button" className={`pm-blocker-check ${b.resolved ? "on" : ""}`} title={b.resolved ? `Cleared${b.owner ? ` — ${b.owner}` : ""} · click to reopen` : "Mark this blocker cleared"} onClick={(e) => { e.stopPropagation(); toggleAt(i); }}>{b.resolved ? "✓" : ""}</button>
            <button type="button" className="pm-blocker-body" onClick={(e) => { e.stopPropagation(); openEditor(i); }}>{b.owner ? <Avatar name={b.owner} map={map} /> : null}<span className="pm-blocker-text">{b.text || "(blocker)"}</span></button>
          </div>
        ))}
        <button ref={m.btnRef} type="button" className="pm-blocker-addbtn" onClick={(e) => { e.stopPropagation(); openEditor("new"); }}>{list.length ? "＋ Add blocker" : "＋ Blocker"}</button>
      </div>
      {m.open && m.pos && editing !== null && <>
        <div className="pm-dd-back" onClick={(e) => { e.preventDefault(); e.stopPropagation(); closeEditor(); }} />
        <div className="pm-dd-menu pm-blockermenu" style={{ top: m.pos.top, left: m.pos.left, minWidth: Math.max(m.pos.width, 300) }} onClick={(e) => e.stopPropagation()}>
          <div className="pm-blk-label">Waiting on</div>
          <Select value={owner} options={roster} placeholder="Anyone" onChange={setOwner} minWidth={260} />
          <div className="pm-dd-add pm-blk-add"><input value={draftName} placeholder="…or add a new person" onChange={(e) => setDraftName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addInline(); } }} /><button type="button" onClick={addInline}>Add</button></div>
          <div className="pm-blk-label">What needs to happen</div>
          <textarea className="pm-blk-text" rows={3} value={txt} placeholder="e.g. Need the surgeon-office list reviewed before I can send" onChange={(e) => setTxt(e.target.value)} />
          <div className="pm-blk-foot">
            {typeof editing === "number" ? <button type="button" className="pm-blk-remove" onClick={() => { onChange(list.filter((_, j) => j !== editing)); closeEditor(); }}>Remove</button> : <span />}
            <div className="pm-blk-foot-r">{typeof editing === "number" && <button type="button" className="pm-blk-resolve" onClick={() => { toggleAt(editing); closeEditor(); }}>{list[editing]?.resolved ? "Reopen" : "Mark cleared"}</button>}<button type="button" className="pm-blk-save" onClick={commit}>Save</button></div>
          </div>
        </div>
      </>}
    </div>
  );
}

type Draft = { key: string; clientSlug: string; title: string; owner: string; stage: string; context: string; due: string; priority: string; links: LinkItem[] };
function TableView({ tasks, h, onUpdate, onCreate, week }: { tasks: BoardTask[]; h: Handlers; onUpdate: (id: string, f: Record<string, unknown>) => void; onCreate: (slug: string, f: NewFields) => void; week?: string }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const keyRef = useRef(0);
  const clientOpts = clientOptsOf(h.clients);
  const addDraft = () => setDrafts((d) => [...d, { key: `d${keyRef.current++}`, clientSlug: h.clients[0]?.slug ?? "", title: "", owner: "", stage: "todo", context: "", due: "", priority: "", links: [] }]);
  const setDraft = (key: string, patch: Partial<Draft>) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const commit = (key: string) => { const d = drafts.find((x) => x.key === key); if (!d || !d.title.trim() || !d.clientSlug) return; onCreate(d.clientSlug, { title: d.title, stage: d.stage, assignee: d.owner, dueDate: d.due, context: d.context, priority: d.priority, links: d.links, week }); setDrafts((p) => p.filter((x) => x.key !== key)); };
  return (
    <div className="pm-table-wrap">
      <div className="pm-table-scroll">
        <table className="pm-table pm-table-edit">
          <colgroup><col style={{ width: "9%" }} /><col style={{ width: "12%" }} /><col style={{ width: "10%" }} /><col style={{ width: 108 }} /><col style={{ width: 128 }} /><col style={{ width: "13%" }} /><col /><col style={{ width: 52 }} /><col style={{ width: 186 }} /><col style={{ width: 72 }} /></colgroup>
          <thead><tr><th>Client</th><th>Task name</th><th>Assigned to</th><th>Priority</th><th>Status</th><th>Blockers</th><th>Context</th><th>Links</th><th>Dates</th><th /></tr></thead>
          <tbody>
            {tasks.map((t) => { const pc = prioOf(t.priority)?.color; return (
              <tr key={t.id} className={pc ? "rp" : ""} style={pc ? ({ ["--rc" as string]: pc } as React.CSSProperties) : undefined}>
                <td><Select value={t.clientSlug ?? ""} options={clientOpts} size="lg" onChange={(v) => onUpdate(t.id, { moveToSlug: v })} /></td>
                <td><AutoTextarea className="pm-cell-title" defaultValue={t.title} onCommit={(v) => { if (v !== t.title && v.trim()) onUpdate(t.id, { title: v }); }} /></td>
                <td><MultiPeople value={t.owner || ""} people={h.people} map={h.map} stack onChange={(v) => onUpdate(t.id, { owner: v })} addPerson={h.addPerson} removePerson={h.removePerson} uploadAvatar={h.uploadAvatar} /></td>
                <td><Select value={t.priority || ""} options={prioOpts} placeholder="None" tone={prioOf(t.priority)?.color} onChange={(v) => onUpdate(t.id, { priority: v })} /></td>
                <td><Select value={t.stage} options={stageOpts} tone={stageOf(t.stage).color} onChange={(v) => onUpdate(t.id, { stage: v })} /></td>
                <td><BlockerCell blockers={t.blocker} people={h.people} map={h.map} addPerson={h.addPerson} onChange={(blk) => onUpdate(t.id, { blocker: blk })} /></td>
                <td><AutoTextarea defaultValue={t.context || ""} onCommit={(v) => { if ((v || null) !== (t.context || null)) onUpdate(t.id, { context: v }); }} /></td>
                <td><LinksCell links={linkItems(t.links)} onChange={(l) => onUpdate(t.id, { links: l })} /></td>
                <td><DatesCell created={t.created_at} updated={t.updated_at} by={t.updated_by} map={h.map} /></td>
                <td><div className="pm-rowacts"><button type="button" className="pm-rowopen" title={t.created_at ? `Open · added ${fmtEst(t.created_at)}` : "Open task"} onClick={() => h.onOpen(t)}>⤢</button><SlackButton id={t.id} channel={h.notifyChannel} /></div></td>
              </tr>
            ); })}
            {drafts.map((d) => { const pc = prioOf(d.priority)?.color; return (
              <tr key={d.key} className={`pm-draftrow ${pc ? "rp" : ""}`} style={pc ? ({ ["--rc" as string]: pc } as React.CSSProperties) : undefined}>
                <td><Select value={d.clientSlug} options={clientOpts} size="lg" onChange={(v) => setDraft(d.key, { clientSlug: v })} /></td>
                <td><input className="pm-cellin pm-cell-title" autoFocus value={d.title} placeholder="New task…" onChange={(e) => setDraft(d.key, { title: e.target.value })} onBlur={() => commit(d.key)} onKeyDown={(e) => { if (e.key === "Enter") commit(d.key); }} /></td>
                <td><MultiPeople value={d.owner} people={h.people} map={h.map} stack onChange={(v) => setDraft(d.key, { owner: v })} addPerson={h.addPerson} removePerson={h.removePerson} uploadAvatar={h.uploadAvatar} /></td>
                <td><Select value={d.priority} options={prioOpts} placeholder="None" tone={prioOf(d.priority)?.color} onChange={(v) => setDraft(d.key, { priority: v })} /></td>
                <td><Select value={d.stage} options={stageOpts} tone={stageOf(d.stage).color} onChange={(v) => setDraft(d.key, { stage: v })} /></td>
                <td><span className="pm-blk-later">—</span></td>
                <td><AutoTextarea defaultValue={d.context} onCommit={(v) => setDraft(d.key, { context: v })} /></td>
                <td><LinksCell links={d.links} onChange={(l) => setDraft(d.key, { links: l })} /></td>
                <td><span className="pm-rowdate">—</span></td>
                <td><button type="button" className="pm-rowdel" title="Remove row" onClick={() => setDrafts((p) => p.filter((x) => x.key !== d.key))}>✕</button></td>
              </tr>
            ); })}
            {tasks.length === 0 && drafts.length === 0 && <tr><td colSpan={10} className="pm-td-empty">No tasks yet.</td></tr>}
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
          <div className="pm-swwho">{owner === "Unassigned" ? <span className="pm-av pm-av-none">?</span> : <Avatar name={owner} map={h.map} />}{owner}</div>
          {cols.map((c) => <div className="pm-swcell" key={c.key} onDragOver={(e) => e.preventDefault()} onDrop={() => { const id = draggingId(h); activeDrag.id = null; if (id) h.onMove(id, dropStage(c.key)); }}>{tasks.filter((t) => has(t, owner) && inCol(t, c.key)).map((t) => <Card key={t.id} t={t} h={h} />)}</div>)}
        </div>
      ))}
    </div>
  );
}
function TaskEditor({ state, clients, people, map, multi, notifyChannel, addPerson, removePerson, uploadAvatar, onClose, onCreate, onUpdate, onDelete }: { state: Exclude<EditorState, null>; clients: BoardClient[]; people: Person[]; map: Record<string, string>; multi: boolean; notifyChannel?: string; addPerson: (n: string) => void; removePerson: (n: string) => void; uploadAvatar: (n: string, f: File) => void; onClose: () => void; onCreate: (clientSlug: string, f: NewFields) => void; onUpdate: (id: string, f: Record<string, unknown>) => void; onDelete: (id: string) => void }) {
  const isNew = state.mode === "new"; const task = isNew ? null : state.task;
  const [title, setTitle] = useState(task?.title ?? "");
  const [slug, setSlug] = useState((isNew ? state.clientSlug : task?.clientSlug) ?? clients[0]?.slug ?? "");
  const [owner, setOwner] = useState((isNew ? state.assignee : task?.owner) ?? "");
  const [due, setDue] = useState(task?.due_date ?? "");
  const [week, setWeek] = useState(task?.week ?? "");
  const [priority, setPriority] = useState(task?.priority ?? "");
  const [context, setContext] = useState(task?.context ?? "");
  const [links, setLinks] = useState<LinkItem[]>(linkItems(task?.links));
  const [blockers, setBlockers] = useState<Blocker[]>(blockerList(task?.blocker));
  const [checks, setChecks] = useState<Checks>({ list: Boolean(task?.checks?.list), messaging: Boolean(task?.checks?.messaging) });
  const [nUrl, setNUrl] = useState(""); const [nTitle, setNTitle] = useState("");
  const addLink = () => { const u = nUrl.trim(); if (!u) return; setLinks((p) => [...p, { url: normUrl(u), title: nTitle.trim() || undefined }]); setNUrl(""); setNTitle(""); };
  const [stage, setStage] = useState(isNew ? state.stage : (task?.stage ?? "todo"));
  const s = stageOf(stage);
  const client = clients.find((c) => c.slug === slug);
  const save = () => { if (!title.trim()) return; if (isNew) { if (!slug) return; onCreate(slug, { title, stage, assignee: owner, dueDate: due, context, links, priority, ...(week ? { week } : {}), ...(checks.list || checks.messaging ? { checks } : {}) }); } else onUpdate(task!.id, { title, stage, owner, dueDate: due, context, links, priority, blocker: blockers, week, checks }); onClose(); };
  return (
    <div className="pm-modal-back" onClick={onClose}>
      <div className="pm-modal pm-modal-a" onClick={(e) => e.stopPropagation()}>
        <div className="pm-ed-head">
          <div className="pm-ed-htop">
            <span className={`pm-stg ${s.cls}`}><span className="d" />{s.label}</span>
            <div className="pm-ed-hactions">{!isNew && <SlackButton id={task!.id} channel={notifyChannel} />}<button type="button" className="pm-modal-x" onClick={onClose}>✕</button></div>
          </div>
          {multi && client && <div className="pm-ed-client"><span className="pm-ed-clogo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>{client.logoUrl ? <img src={client.logoUrl} alt="" /> : initials(client.name)}</span><span className="pm-ed-cname">{client.name}</span></div>}
          <input className="pm-ed-title" autoFocus value={title} placeholder="What needs doing?" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }} />
          {!isNew && task?.created_at && <div className="pm-ed-added">Added {fmtEst(task.created_at)} · sitting {sittingFor(task.created_at)}</div>}
        </div>
        <div className="pm-ed-body">
          <div className="pm-ed-main">
            <div className="pm-f pm-f-notes"><span>Context / notes</span><RichNotes value={context} onChange={setContext} /></div>
            {!isNew && task && !task.id.startsWith("tmp") && <div className="pm-f pm-f-updates"><span>Latest update</span><LatestUpdates taskId={task.id} people={people} map={map} /></div>}
            <div className="pm-f"><span>Links &amp; files</span><div className="pm-links">
              {links.map((l, i) => <div className="pm-link" key={i}><a href={l.url} target="_blank" rel="noreferrer">{linkLabel(l)}</a><button type="button" onClick={() => setLinks((p) => p.filter((_, j) => j !== i))}>✕</button></div>)}
              <div className="pm-link-add pm-link-add2"><input value={nTitle} placeholder="Title (optional)" onChange={(e) => setNTitle(e.target.value)} /><input value={nUrl} placeholder="Paste a URL…" onChange={(e) => setNUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} /><button type="button" onClick={addLink}>Add</button></div>
            </div></div>
          </div>
          <div className="pm-ed-side">
            {isNew && multi && <div className="pm-f"><span>Client</span><Select value={slug} options={clientOptsOf(clients)} size="lg" onChange={setSlug} /></div>}
            <div className="pm-f"><span>Assignees</span><MultiPeople value={owner} people={people} map={map} onChange={setOwner} addPerson={addPerson} removePerson={removePerson} uploadAvatar={uploadAvatar} /></div>
            <div className="pm-f-row">
              <div className="pm-f"><span>Status</span><Select value={stage} options={stageOpts} tone={stageOf(stage).color} onChange={setStage} /></div>
              <div className="pm-f"><span>Priority</span><Select value={priority} options={prioOpts} placeholder="None" tone={prioOf(priority)?.color} onChange={setPriority} /></div>
            </div>
            <div className="pm-f-row">
              <label className="pm-f"><span>Due date</span><input value={due} placeholder="e.g. Thu 9/4" onChange={(e) => setDue(e.target.value)} /></label>
              <label className="pm-f"><span>Start date</span><input value={week} placeholder="e.g. Mon 9/8" onChange={(e) => setWeek(e.target.value)} /></label>
            </div>
            <div className="pm-f"><span>Campaign checklist</span><div className="pm-ed-checks">
              <button type="button" className={`pm-ed-check ${checks.list ? "on" : ""}`} aria-pressed={checks.list} onClick={() => setChecks((c) => ({ ...c, list: !c.list }))}><span className="pm-check">{checks.list ? "✓" : ""}</span>Contact list built</button>
              <button type="button" className={`pm-ed-check ${checks.messaging ? "on" : ""}`} aria-pressed={checks.messaging} onClick={() => setChecks((c) => ({ ...c, messaging: !c.messaging }))}><span className="pm-check">{checks.messaging ? "✓" : ""}</span>Messaging created</button>
            </div></div>
            <div className="pm-f"><span>Blockers</span><div className="pm-ed-blockers"><BlockerCell blockers={blockers} people={people} map={map} addPerson={addPerson} onChange={setBlockers} /></div></div>
          </div>
        </div>
        <div className="pm-modal-foot">{!isNew ? <button type="button" className="pm-del" onClick={() => { onDelete(task!.id); onClose(); }}>Delete</button> : <span />}<button type="button" className="pm-save" onClick={save}>{isNew ? "Create task" : "Save"}</button></div>
      </div>
    </div>
  );
}

const SORTS: [SortKey, string][] = [["manual", "Manual order"], ["priority", "Priority"], ["due", "Due date"], ["status", "Status"], ["title", "Task name"], ["assignee", "Assignee"]];
export default function ProjectBoard({ tasks, clients, defaultView, notifyChannel, onCreate, onUpdate, onDelete, onMove, onSetDay, onWeekChange }: {
  tasks: BoardTask[]; clients: BoardClient[]; defaultView?: View; notifyChannel?: string;
  onCreate: (clientSlug: string, fields: NewFields) => void; onUpdate: (id: string, fields: Record<string, unknown>) => void; onDelete: (id: string) => void; onMove: (id: string, stage: string) => void; onSetDay: (id: string, date: string) => void; onWeekChange?: (label: string | null) => void;
}) {
  const multi = clients.length > 1;
  const [view, setView] = useState<View>(defaultView ?? "kanban");
  const [order, setOrder] = useState<View[]>(ALL_VIEWS.map(([v]) => v));
  const [sort, setSort] = useState<SortKey>("manual");
  const [editor, setEditor] = useState<EditorState>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragH, setDragH] = useState(0);
  const [landedId, setLandedId] = useState<string | null>(null);
  const onDrag = (id: string | null, height?: number) => { setDragId(id); if (typeof height === "number") setDragH(Math.round(height)); };
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  // Positions set by dragging, applied straight away while the PATCHes go out.
  const [rank, setRank] = useState<Record<string, number>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [week, setWeek] = useState<string>("");
  const [weeks, setWeeks] = useState<string[]>([]);
  const map = useMemo(() => { const m: Record<string, string> = {}; for (const p of people) if (p.avatarUrl) m[p.name] = p.avatarUrl; return m; }, [people]);

  useEffect(() => {
    try { const v = localStorage.getItem("pm-view") as View | null; const ok = v && ALL_VIEWS.some(([k]) => k === v) && (v !== "byclient" || multi); if (v && ok) setView(v); else if (defaultView) setView(defaultView); } catch { /* ignore */ }
    try { const o = JSON.parse(localStorage.getItem("pm-view-order") || "[]") as View[]; if (Array.isArray(o) && o.length) setOrder([...o.filter((v) => ALL_VIEWS.some(([k]) => k === v)), ...ALL_VIEWS.map(([k]) => k).filter((k) => !o.includes(k))]); } catch { /* ignore */ }
  }, [defaultView, multi]);
  useEffect(() => { void fetch("/api/project-management/people", { cache: "no-store" }).then((r) => r.json()).then((p) => setPeople(Array.isArray(p.people) ? p.people : [])).catch(() => {}); }, []);
  useEffect(() => { if (!multi) return; void fetch("/api/project-management/weeks", { cache: "no-store" }).then((r) => r.json()).then((p) => setWeeks(Array.isArray(p.weeks) ? p.weeks : [])).catch(() => {}); }, [multi]);
  useEffect(() => { onWeekChange?.(multi && week ? weekDisplay(week) : null); }, [week, multi, onWeekChange]);

  const pickView = (v: View) => { setView(v); try { localStorage.setItem("pm-view", v); } catch { /* ignore */ } };
  const reorderViews = (keys: View[]) => { setOrder(keys); try { localStorage.setItem("pm-view-order", JSON.stringify(keys)); } catch { /* ignore */ } };
  const addPerson = (name: string) => { setPeople((p) => (p.some((x) => x.name.toLowerCase() === name.toLowerCase()) ? p : [...p, { name, avatarUrl: null }].sort((a, z) => a.name.localeCompare(z.name)))); void fetch("/api/project-management/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => {}); };
  const removePerson = (name: string) => { setPeople((p) => p.filter((x) => x.name !== name)); void fetch(`/api/project-management/people?name=${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {}); };
  const setAvatar = (name: string, url: string) => { setPeople((p) => { const found = p.find((x) => x.name === name); if (found) return p.map((x) => (x.name === name ? { ...x, avatarUrl: url } : x)); return [...p, { name, avatarUrl: url }].sort((a, z) => a.name.localeCompare(z.name)); }); void fetch("/api/project-management/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, avatarUrl: url }) }).catch(() => {}); };
  const uploadAvatar = (name: string, file: File) => { const fd = new FormData(); fd.append("file", file); void fetch("/api/project-management/upload-logo", { method: "POST", body: fd }).then((r) => r.json()).then((r) => { if (r.ok && r.logoUrl) setAvatar(name, r.logoUrl); }).catch(() => {}); };
  const addWeek = (label: string) => { setWeeks((w) => (w.some((x) => x.toLowerCase() === label.toLowerCase()) ? w : [...w, label])); setWeek(label); void fetch("/api/project-management/weeks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ week: label }) }).catch(() => {}); };
  const removeWeek = (label: string) => { setWeeks((w) => w.filter((x) => x !== label)); if (week === label) setWeek(""); void fetch(`/api/project-management/weeks?week=${encodeURIComponent(label)}`, { method: "DELETE" }).catch(() => {}); };

  const allWeeks = useMemo(() => { const set = new Set<string>(weeks); for (const t of tasks) if (t.week) set.add(t.week); return Array.from(set); }, [weeks, tasks]);
  const visible = useMemo(() => {
    const base = multi && week ? tasks.filter((t) => t.week === week) : tasks;
    // Manual order is the dragged order: each task's position, with any just-dragged ones applied.
    const pos = (t: BoardTask, i: number) => rank[t.id] ?? (typeof t.position === "number" ? t.position : Number.MAX_SAFE_INTEGER - tasks.length + i);
    const ordered = sort === "manual" ? base.map((t, i) => [t, pos(t, i)] as const).sort((a, b) => a[1] - b[1]).map(([t]) => t) : base;
    return sortTasks(ordered, sort);
  }, [tasks, multi, week, sort, rank]);
  /** Puts the dragged task before/after the target, renumbers that column 0..n, and saves the new positions. */
  const reorder = (ids: string[], targetId: string, after: boolean, movingId?: string) => {
    const moving = movingId ?? activeDrag.id ?? dragId; activeDrag.id = null; setDropHint(null); setDragId(null);
    if (moving) { setLandedId(moving); window.setTimeout(() => setLandedId((cur) => (cur === moving ? null : cur)), 700); }
    if (!moving || moving === targetId) return;
    const rest = ids.filter((id) => id !== moving);
    const at = rest.indexOf(targetId);
    if (at < 0) return;
    rest.splice(after ? at + 1 : at, 0, moving);
    const next: Record<string, number> = {};
    rest.forEach((id, i) => { next[id] = i * 10; });
    setRank((r) => ({ ...r, ...next }));
    if (sort !== "manual") setSort("manual");
    const current = new Map(tasks.map((t) => [t.id, rank[t.id] ?? t.position]));
    for (const [id, position] of Object.entries(next)) {
      if (current.get(id) === position || id.startsWith("tmp")) continue;
      void fetch("/api/project-management/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, position }) }).catch(() => {});
    }
  };
  const create = (slug: string, f: NewFields) => onCreate(slug, { ...f, week: multi && week ? week : undefined });
  const h: Handlers = { clients, multi, people, map, addPerson, removePerson, uploadAvatar, openNew: (stage, clientSlug, assignee) => setEditor({ mode: "new", stage, clientSlug, assignee }), onOpen: (t) => setEditor({ mode: "edit", task: t }), onDelete, notifyChannel, onDrag, dragId, dragH, landedId, onMove, onSetDay, onReorder: reorder, dropHint, setDropHint };
  const byStage = useMemo(() => { const m: Record<string, BoardTask[]> = {}; for (const s of STAGES) m[s.key] = []; for (const t of visible) (m[t.stage] || m.todo).push(t); return m; }, [visible]);
  const views: [View, string][] = order.filter((v) => v !== "byclient" || multi).map((v) => ALL_VIEWS.find(([k]) => k === v)!);

  return (
    <>
      <div className="pm-boardbar">
        <FiltersPanel view={view} views={views} onPickView={pickView} onReorderViews={reorderViews} sort={sort} onSort={setSort} multi={multi} week={week} weeks={allWeeks} onPickWeek={setWeek} onAddWeek={addWeek} onRemoveWeek={removeWeek} />
      </div>
      {view === "kanban" && <KanbanView byStage={byStage} h={h} />}
      {view === "byclient" && multi && <ByClientView tasks={visible} h={h} />}
      {view === "individuals" && <IndividualsView tasks={visible} h={h} />}
      {view === "table" && <TableView tasks={visible} h={h} onUpdate={onUpdate} onCreate={create} week={multi && week ? week : undefined} />}
      {view === "swimlanes" && <SwimlanesView tasks={visible} h={h} />}
      {editor && <TaskEditor state={editor} clients={clients} people={people} map={map} multi={multi} notifyChannel={notifyChannel} addPerson={addPerson} removePerson={removePerson} uploadAvatar={uploadAvatar} onClose={() => setEditor(null)} onCreate={create} onUpdate={onUpdate} onDelete={onDelete} />}
    </>
  );
}
