// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";

export type LinkItem = { url: string; title?: string };
export type Blocker = { owner?: string; text?: string; resolved?: boolean; resolvedAt?: string };
export type BoardTask = { id: string; title: string; stage: string; owner: string | null; due_date: string | null; context?: string | null; links?: (string | LinkItem)[]; priority?: string | null; week?: string | null; blocker?: Blocker | null; source: string; clientSlug?: string; clientName?: string };
export type BoardClient = { slug: string; name: string; logoUrl?: string | null; accentColor?: string | null };
export type Person = { name: string; avatarUrl?: string | null };
type View = "kanban" | "byclient" | "individuals" | "table" | "swimlanes" | "list" | "timeline" | "pipeline";
type SortKey = "manual" | "priority" | "due" | "status" | "title" | "assignee";
export type NewFields = { title: string; stage: string; assignee?: string; dueDate?: string; context?: string; links?: LinkItem[]; priority?: string; week?: string };

const STAGES = [
  { key: "todo", label: "To do", cls: "todo", color: "#6b7280" },
  { key: "in_progress", label: "In progress", cls: "prog", color: "#5aa9f0" },
  { key: "paused", label: "Paused", cls: "pause", color: "#e0a83d" },
  { key: "completed", label: "Completed", cls: "done", color: "#3fb27f" },
  { key: "launched", label: "Launched", cls: "launch", color: "#7c6cf0" },
];
const PRIORITIES = [{ key: "high", label: "High", color: "#e5484d" }, { key: "medium", label: "Medium", color: "#f2913d" }, { key: "low", label: "Low", color: "#e6c229" }];
const ALL_VIEWS: [View, string][] = [["kanban", "Kanban"], ["byclient", "By client"], ["individuals", "Individuals"], ["table", "Table"], ["swimlanes", "Swimlanes"], ["list", "List"], ["timeline", "Week"], ["pipeline", "Pipeline"]];
const stageOf = (k: string) => STAGES.find((x) => x.key === k) ?? STAGES[0];
const prioOf = (k?: string | null) => PRIORITIES.find((x) => x.key === k) ?? null;
const prioRank = (k?: string | null) => { const i = PRIORITIES.findIndex((p) => p.key === k); return i < 0 ? 9 : i; };
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();
const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
const ownerList = (o?: string | null) => (o ? o.split(",").map((s) => s.trim()).filter(Boolean) : []);
const linkItems = (links?: (string | LinkItem)[]): LinkItem[] => (Array.isArray(links) ? links.map((l) => (typeof l === "string" ? { url: l } : l)).filter((l) => l && l.url) : []);
const normUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
const linkLabel = (l: LinkItem) => { if (l.title && l.title.trim()) return l.title.trim(); try { const x = new URL(l.url); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, ""); } catch { return l.url; } };
const shortDate = (v?: string | null) => { if (!v) return ""; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00" : v); return Number.isNaN(+d) ? v : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
const dueMs = (v?: string | null) => { if (!v) return Infinity; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00" : v); return Number.isNaN(+d) ? Infinity : +d; };
export const weekDisplay = (w?: string | null) => (!w ? "" : /^week of/i.test(w) ? w : `Week of ${w}`);
function iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function weekdays() { const now = new Date(); const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); const t = iso(now); return ["Mon", "Tue", "Wed", "Thu", "Fri"].map((label, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return { label, date: iso(d), today: iso(d) === t }; }); }
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
function Chevron() { return <svg className="pm-chev" viewBox="0 0 10 6" width="10" height="6" aria-hidden><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function useMenu(minW = 0) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const place = () => { const r = btnRef.current?.getBoundingClientRect(); if (!r) return; const width = Math.max(r.width, minW); const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 10)); setPos({ top: r.bottom + 5, left, width }); };
  const toggle = () => { if (pos) setPos(null); else place(); };
  const close = () => setPos(null);
  useEffect(() => { if (!pos) return; const h = () => setPos(null); window.addEventListener("scroll", h, true); window.addEventListener("resize", h); return () => { window.removeEventListener("scroll", h, true); window.removeEventListener("resize", h); }; }, [pos]);
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
        <div className="pm-dd-back" onClick={(e) => { e.stopPropagation(); m.close(); }} />
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
        <div className="pm-dd-back" onClick={(e) => { e.stopPropagation(); m.close(); }} />
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
        <div className="pm-dd-back" onClick={(e) => { e.stopPropagation(); m.close(); }} />
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
              <div className="pm-filt-h">Week</div>
              <button type="button" className={`pm-dd-opt ${!week ? "on" : ""}`} onClick={() => onPickWeek("")}><span className="pm-dd-opt-l">All time</span>{!week && <span className="pm-dd-ck">✓</span>}</button>
              {weeks.map((w) => (
                <div className={`pm-dd-opt multi ${w === week ? "on" : ""}`} key={w}>
                  <button type="button" className="pm-dd-optmain" onClick={() => onPickWeek(w)}><span className="pm-dd-opt-l">{weekDisplay(w)}</span>{w === week && <span className="pm-dd-ck">✓</span>}</button>
                  <button type="button" className="pm-dd-rm" title="Remove week" onClick={() => onRemoveWeek(w)}>✕</button>
                </div>
              ))}
              <div className="pm-dd-add"><input value={draft} placeholder="New week, e.g. Sept 3" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /><button type="button" onClick={add}>Add</button></div>
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
  onDrag: (id: string | null) => void; dragId: string | null; onMove: (id: string, stage: string) => void; onSetDay: (id: string, date: string) => void;
};
function clientLogo(c: BoardClient) { return c.logoUrl ? <img className="pm-opt-logo" src={c.logoUrl} alt="" /> : <span className="pm-opt-logo mono" style={{ background: c.accentColor || "var(--accent)" }}>{initials(c.name)}</span>; }
const clientOptsOf = (clients: BoardClient[]): Opt[] => clients.map((c) => ({ value: c.slug, label: c.name, logo: clientLogo(c) }));
const stageOpts: Opt[] = STAGES.map((s) => ({ value: s.key, label: s.label, color: s.color }));
const prioOpts: Opt[] = [{ value: "", label: "None" }, ...PRIORITIES.map((p) => ({ value: p.key, label: p.label, color: p.color }))];

function PriorityDot({ p }: { p?: string | null }) { const pr = prioOf(p); return pr ? <span className="pm-prio" style={{ background: pr.color }} title={`${pr.label} priority`} /> : null; }
function LinkChips({ links }: { links?: (string | LinkItem)[] }) { const items = linkItems(links); if (!items.length) return null; return <span className="pm-clip">🔗 {items.length}</span>; }
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
        {t.blocker && t.blocker.text && !t.blocker.resolved && <span className="pm-blocked" title={`Blocked${t.blocker.owner ? ` — waiting on ${t.blocker.owner}` : ""}: ${t.blocker.text}`}>⛔ Blocked</span>}
        <Owners owner={t.owner} map={h.map} />
        {t.due_date && <span className="pm-due">{shortDate(t.due_date)}</span>}
        <LinkChips links={t.links} />
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
          <div className="pm-c-meta"><span className={`pm-stg ${stageOf(t.stage).cls}`}><span className="d" />{stageOf(t.stage).label}</span><Owners owner={t.owner} map={h.map} />{t.due_date && <span className="pm-due">{shortDate(t.due_date)}</span>}</div>
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
  const owners = useMemo(() => { const set = new Set<string>(h.people.map((p) => p.name)); for (const t of tasks) for (const o of ownerList(t.owner)) set.add(o); const arr = Array.from(set); arr.push("Unassigned"); return arr; }, [tasks, h.people]);
  return (
    <div className="pm-cols" style={{ gridTemplateColumns: `repeat(${Math.max(1, owners.length)}, minmax(240px, 1fr))` }}>
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
  useEffect(() => { if (ref.current) fit(ref.current); }, []);
  return <textarea ref={ref} className={`pm-cellin pm-cellarea ${className}`} rows={1} defaultValue={defaultValue} placeholder={placeholder} onInput={(e) => fit(e.currentTarget)} onBlur={(e) => onCommit(e.currentTarget.value)} />;
}
/* ── Links cell (table) — titled links in a popover ── */
function LinksCell({ links, onChange }: { links: LinkItem[]; onChange: (l: LinkItem[]) => void }) {
  const m = useMenu(280); const [url, setUrl] = useState(""); const [title, setTitle] = useState("");
  const add = () => { const u = url.trim(); if (!u) return; onChange([...links, { url: normUrl(u), title: title.trim() || undefined }]); setUrl(""); setTitle(""); };
  return (
    <div className="pm-dd pm-linkscell">
      {links.length ? (
        <div className="pm-links-cellrow">
          <span className="pm-linkpills">{links.slice(0, 2).map((l, i) => <a className="pm-linkpill link" key={i} href={l.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{linkLabel(l)}</a>)}{links.length > 2 && <span className="pm-linkpill more">+{links.length - 2}</span>}</span>
          <button ref={m.btnRef} type="button" className="pm-links-edit" title="Edit links" onClick={(e) => { e.stopPropagation(); m.toggle(); }}><Chevron /></button>
        </div>
      ) : (
        <button ref={m.btnRef} type="button" className="pm-dd-btn pm-links-btn" onClick={(e) => { e.stopPropagation(); m.toggle(); }}>
          <span className="pm-dd-val"><span className="pm-dd-ph">Add link…</span></span><Chevron />
        </button>
      )}
      {m.open && m.pos && <>
        <div className="pm-dd-back" onClick={(e) => { e.stopPropagation(); m.close(); }} />
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
function BlockerCell({ blocker, people, map, onChange, addPerson }: { blocker?: Blocker | null; people: Person[]; map: Record<string, string>; onChange: (b: Blocker | null) => void; addPerson: (n: string) => void }) {
  const m = useMenu(300);
  const b = blocker || {};
  const has = !!((b.text && b.text.trim()) || b.owner);
  const resolved = !!b.resolved;
  const [owner, setOwner] = useState(b.owner || "");
  const [txt, setTxt] = useState(b.text || "");
  const [draftName, setDraftName] = useState("");
  useEffect(() => { if (m.open) { setOwner(b.owner || ""); setTxt(b.text || ""); setDraftName(""); } }, [m.open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => { const t = txt.trim(); if (!t && !owner) onChange(null); else onChange({ owner: owner || "", text: t, resolved: b.resolved || false, ...(b.resolvedAt ? { resolvedAt: b.resolvedAt } : {}) }); m.close(); };
  const clearToggle = () => onChange({ owner: b.owner || "", text: b.text || "", resolved: !resolved, ...(!resolved ? { resolvedAt: nowIso() } : {}) });
  const roster: Opt[] = [{ value: "", label: "Anyone" }, ...people.map((p) => ({ value: p.name, label: p.name, logo: <Avatar name={p.name} map={map} /> }))];
  return (
    <div className="pm-dd pm-blockercell">
      {has ? (
        <div className={`pm-blocker-row ${resolved ? "done" : ""}`}>
          <button type="button" className={`pm-blocker-check ${resolved ? "on" : ""}`} title={resolved ? `Cleared${b.owner ? ` by ${b.owner}` : ""} — click to reopen` : "Mark this blocker cleared"} onClick={(e) => { e.stopPropagation(); clearToggle(); }}>{resolved ? "✓" : ""}</button>
          <button ref={m.btnRef} type="button" className="pm-blocker-body" onClick={(e) => { e.stopPropagation(); m.toggle(); }}>
            {b.owner ? <Avatar name={b.owner} map={map} /> : null}
            <span className="pm-blocker-text">{b.text || "(blocker)"}</span>
          </button>
        </div>
      ) : (
        <button ref={m.btnRef} type="button" className="pm-dd-btn pm-blocker-add" onClick={(e) => { e.stopPropagation(); m.toggle(); }}><span className="pm-dd-ph">＋ Blocker</span></button>
      )}
      {m.open && m.pos && <>
        <div className="pm-dd-back" onClick={(e) => { e.stopPropagation(); m.close(); }} />
        <div className="pm-dd-menu pm-blockermenu" style={{ top: m.pos.top, left: m.pos.left, minWidth: Math.max(m.pos.width, 300) }} onClick={(e) => e.stopPropagation()}>
          <div className="pm-blk-label">Waiting on</div>
          <Select value={owner} options={roster} placeholder="Anyone" onChange={setOwner} minWidth={260} />
          <div className="pm-dd-add pm-blk-add"><input value={draftName} placeholder="…or add a new person" onChange={(e) => setDraftName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const n = draftName.trim(); if (n) { addPerson(n); setOwner(n); setDraftName(""); } } }} /><button type="button" onClick={() => { const n = draftName.trim(); if (n) { addPerson(n); setOwner(n); setDraftName(""); } }}>Add</button></div>
          <div className="pm-blk-label">What needs to happen</div>
          <textarea className="pm-blk-text" rows={3} value={txt} placeholder="e.g. Need the surgeon-office list reviewed before I can send" onChange={(e) => setTxt(e.target.value)} />
          <div className="pm-blk-foot">
            {has ? <button type="button" className="pm-blk-remove" onClick={() => { onChange(null); m.close(); }}>Remove</button> : <span />}
            <div className="pm-blk-foot-r">{has && <button type="button" className="pm-blk-resolve" onClick={() => { clearToggle(); m.close(); }}>{resolved ? "Reopen" : "Mark cleared"}</button>}<button type="button" className="pm-blk-save" onClick={save}>Save</button></div>
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
          <colgroup><col style={{ width: "9%" }} /><col style={{ width: "14%" }} /><col style={{ width: "11%" }} /><col style={{ width: 80 }} /><col style={{ width: 104 }} /><col style={{ width: "13%" }} /><col /><col style={{ width: 92 }} /><col style={{ width: 90 }} /><col style={{ width: 62 }} /></colgroup>
          <thead><tr><th>Client</th><th>Task name</th><th>Assigned to</th><th>Priority</th><th>Status</th><th>Blockers</th><th>Context</th><th>Links</th><th>Due date</th><th /></tr></thead>
          <tbody>
            {tasks.map((t) => { const pc = prioOf(t.priority)?.color; return (
              <tr key={t.id} className={pc ? "rp" : ""} style={pc ? ({ ["--rc" as string]: pc } as React.CSSProperties) : undefined}>
                <td><Select value={t.clientSlug ?? ""} options={clientOpts} size="lg" onChange={(v) => onUpdate(t.id, { moveToSlug: v })} /></td>
                <td><AutoTextarea className="pm-cell-title" defaultValue={t.title} onCommit={(v) => { if (v !== t.title && v.trim()) onUpdate(t.id, { title: v }); }} /></td>
                <td><MultiPeople value={t.owner || ""} people={h.people} map={h.map} stack onChange={(v) => onUpdate(t.id, { owner: v })} addPerson={h.addPerson} removePerson={h.removePerson} uploadAvatar={h.uploadAvatar} /></td>
                <td><Select value={t.priority || ""} options={prioOpts} placeholder="None" tone={prioOf(t.priority)?.color} onChange={(v) => onUpdate(t.id, { priority: v })} /></td>
                <td><Select value={t.stage} options={stageOpts} tone={stageOf(t.stage).color} onChange={(v) => onUpdate(t.id, { stage: v })} /></td>
                <td><BlockerCell blocker={t.blocker} people={h.people} map={h.map} addPerson={h.addPerson} onChange={(blk) => onUpdate(t.id, { blocker: blk })} /></td>
                <td><AutoTextarea defaultValue={t.context || ""} onCommit={(v) => { if ((v || null) !== (t.context || null)) onUpdate(t.id, { context: v }); }} /></td>
                <td><LinksCell links={linkItems(t.links)} onChange={(l) => onUpdate(t.id, { links: l })} /></td>
                <td><input className="pm-cellin" defaultValue={t.due_date || ""} onBlur={(e) => { if ((e.target.value || null) !== (t.due_date || null)) onUpdate(t.id, { dueDate: e.target.value }); }} /></td>
                <td><div className="pm-rowacts"><SlackButton id={t.id} channel={h.notifyChannel} /><button type="button" className="pm-rowdel" title="Delete task" onClick={() => { if (window.confirm("Delete this task?")) h.onDelete(t.id); }}>🗑</button></div></td>
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
                <td><input className="pm-cellin" value={d.due} onChange={(e) => setDraft(d.key, { due: e.target.value })} /></td>
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
              {ownerList(t.owner).length ? <Owners owner={t.owner} map={h.map} /> : <span className="pm-av pm-av-none">?</span>}
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
          <Owners owner={t.owner} map={h.map} />
        </div>); })}
      <div className="pm-prow pm-prow-add"><button type="button" className="pm-add" onClick={() => h.openNew("todo", h.multi ? undefined : h.clients[0]?.slug)}>+ Add a project</button></div>
    </div>
  );
}

function TaskEditor({ state, clients, people, map, multi, addPerson, removePerson, uploadAvatar, onClose, onCreate, onUpdate, onDelete }: { state: Exclude<EditorState, null>; clients: BoardClient[]; people: Person[]; map: Record<string, string>; multi: boolean; addPerson: (n: string) => void; removePerson: (n: string) => void; uploadAvatar: (n: string, f: File) => void; onClose: () => void; onCreate: (clientSlug: string, f: NewFields) => void; onUpdate: (id: string, f: Record<string, unknown>) => void; onDelete: (id: string) => void }) {
  const isNew = state.mode === "new"; const task = isNew ? null : state.task;
  const [title, setTitle] = useState(task?.title ?? "");
  const [slug, setSlug] = useState((isNew ? state.clientSlug : task?.clientSlug) ?? clients[0]?.slug ?? "");
  const [owner, setOwner] = useState((isNew ? state.assignee : task?.owner) ?? "");
  const [due, setDue] = useState(task?.due_date ?? "");
  const [priority, setPriority] = useState(task?.priority ?? "");
  const [context, setContext] = useState(task?.context ?? "");
  const [links, setLinks] = useState<LinkItem[]>(linkItems(task?.links));
  const [nUrl, setNUrl] = useState(""); const [nTitle, setNTitle] = useState("");
  const addLink = () => { const u = nUrl.trim(); if (!u) return; setLinks((p) => [...p, { url: normUrl(u), title: nTitle.trim() || undefined }]); setNUrl(""); setNTitle(""); };
  const clientName = clients.find((c) => c.slug === slug)?.name;
  const save = () => { if (!title.trim()) return; if (isNew) { if (!slug) return; onCreate(slug, { title, stage: state.stage, assignee: owner, dueDate: due, context, links, priority }); } else onUpdate(task!.id, { title, owner, dueDate: due, context, links, priority }); onClose(); };
  return (
    <div className="pm-modal-back" onClick={onClose}>
      <div className="pm-modal pm-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="pm-modal-head"><h2>{isNew ? "New task" : "Task details"}{clientName && multi ? ` · ${clientName}` : ""}</h2><button type="button" className="pm-modal-x" onClick={onClose}>✕</button></div>
        <div className="pm-modal-body">
          {isNew && multi && <div className="pm-f"><span>Client</span><Select value={slug} options={clientOptsOf(clients)} size="lg" onChange={setSlug} /></div>}
          <label className="pm-f"><span>Title</span><input autoFocus value={title} placeholder="What needs doing?" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }} /></label>
          <div className="pm-f-row">
            <div className="pm-f"><span>Assignees</span><MultiPeople value={owner} people={people} map={map} onChange={setOwner} addPerson={addPerson} removePerson={removePerson} uploadAvatar={uploadAvatar} /></div>
            <div className="pm-f"><span>Priority</span><Select value={priority} options={prioOpts} placeholder="None" tone={prioOf(priority)?.color} onChange={setPriority} /></div>
          </div>
          <label className="pm-f"><span>Due date</span><input value={due} placeholder="e.g. Thu 9/4 or 2026-09-04" onChange={(e) => setDue(e.target.value)} /></label>
          <label className="pm-f"><span>Context / notes</span><textarea rows={3} value={context} onChange={(e) => setContext(e.target.value)} /></label>
          <div className="pm-f"><span>Links &amp; files</span><div className="pm-links">
            {links.map((l, i) => <div className="pm-link" key={i}><a href={l.url} target="_blank" rel="noreferrer">{linkLabel(l)}</a><button type="button" onClick={() => setLinks((p) => p.filter((_, j) => j !== i))}>✕</button></div>)}
            <div className="pm-link-add pm-link-add2"><input value={nTitle} placeholder="Title (optional)" onChange={(e) => setNTitle(e.target.value)} /><input value={nUrl} placeholder="Paste a URL…" onChange={(e) => setNUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} /><button type="button" onClick={addLink}>Add</button></div>
          </div></div>
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
  const [people, setPeople] = useState<Person[]>([]);
  const [week, setWeek] = useState<string>("");
  const [weeks, setWeeks] = useState<string[]>([]);
  const map = useMemo(() => { const m: Record<string, string> = {}; for (const p of people) if (p.avatarUrl) m[p.name] = p.avatarUrl; return m; }, [people]);

  useEffect(() => {
    try { const v = localStorage.getItem("pm-view") as View | null; const ok = (v && v !== "byclient") || (v === "byclient" && multi); if (v && ok) setView(v); else if (defaultView) setView(defaultView); } catch { /* ignore */ }
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
  const visible = useMemo(() => { const base = multi && week ? tasks.filter((t) => t.week === week) : tasks; return sortTasks(base, sort); }, [tasks, multi, week, sort]);
  const create = (slug: string, f: NewFields) => onCreate(slug, { ...f, week: multi && week ? week : undefined });
  const h: Handlers = { clients, multi, people, map, addPerson, removePerson, uploadAvatar, openNew: (stage, clientSlug, assignee) => setEditor({ mode: "new", stage, clientSlug, assignee }), onOpen: (t) => setEditor({ mode: "edit", task: t }), onDelete, notifyChannel, onDrag: setDragId, dragId, onMove, onSetDay };
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
      {view === "list" && <ListView byStage={byStage} h={h} />}
      {view === "timeline" && <TimelineView tasks={visible} h={h} />}
      {view === "pipeline" && <PipelineView tasks={visible} h={h} />}
      {editor && <TaskEditor state={editor} clients={clients} people={people} map={map} multi={multi} addPerson={addPerson} removePerson={removePerson} uploadAvatar={uploadAvatar} onClose={() => setEditor(null)} onCreate={create} onUpdate={onUpdate} onDelete={onDelete} />}
    </>
  );
}
