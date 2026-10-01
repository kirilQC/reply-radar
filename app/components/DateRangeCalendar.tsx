// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A date-range picker that opens a calendar rather than asking someone to type mm/dd/yyyy into a native
 * field. Two clicks pick a range — the first begins it, the second closes it — and clicking before the
 * start just begins again. Values are the same YYYY-MM-DD strings the native inputs produced, so it drops
 * straight into anything that already drove `customSince`/`customUntil`. Closes on an outside click or Escape.
 */

type Props = {
  since: string;
  until: string;
  onChange: (since: string, until: string) => void;
  align?: "left" | "right";
};

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parse = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
};
const short = (value: string) => { const date = parse(value); return date ? date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""; };

export default function DateRangeCalendar({ since, until, onChange, align = "left" }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(() => parse(since) || parse(until) || new Date());
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Fixed position from the trigger's rect, portaled to <body>, so the calendar is never clipped by a
  // scrolling config card or the inbox's own overflow, and flips above the button when there is no room below.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => { if (open) setView(parse(since) || parse(until) || new Date()); }, [open, since, until]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 252;
      const height = 320;
      const left = align === "right"
        ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
        : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const top = rect.bottom + 6 + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
      setPos({ top, left });
    };
    place();
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current && !ref.current.contains(target) && !(triggerRef.current && triggerRef.current.contains(target))) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onScroll = (event: Event) => { const target = event.target; if (target instanceof Element && ref.current?.contains(target)) return; setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", place); window.removeEventListener("scroll", onScroll, true); };
  }, [open, align]);

  const start = parse(since);
  const end = parse(until);

  const pick = (day: Date) => {
    const value = iso(day);
    if (!start || (start && end)) { onChange(value, ""); return; } // begin a fresh range
    if (day < start) { onChange(value, ""); return; } // clicked before the start — restart from here
    onChange(since, value); // close the range
  };

  const cells = useMemo(() => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const lead = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const list: (Date | null)[] = [];
    for (let i = 0; i < lead; i += 1) list.push(null);
    for (let d = 1; d <= days; d += 1) list.push(new Date(year, month, d));
    while (list.length % 7) list.push(null);
    return list;
  }, [view]);

  const isEdge = (day: Date) => (start && iso(day) === iso(start)) || (end && iso(day) === iso(end));
  const inRange = (day: Date) => start && end && day > start && day < end;
  const today = iso(new Date());

  const label = since || until ? `${short(since) || "Start"} → ${short(until) || "End"}` : "Pick dates";

  const popover = open ? (
    <div className="cal-pop" ref={ref} style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }} onClick={(event) => event.stopPropagation()}>
          <div className="cal-head">
            <button type="button" aria-label="Previous month" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}>‹</button>
            <span>{view.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
            <button type="button" aria-label="Next month" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}>›</button>
          </div>
          <div className="cal-grid cal-dow">{DOW.map((day, index) => <span key={index}>{day}</span>)}</div>
          <div className="cal-grid">
            {cells.map((day, index) => day === null ? (
              <span key={index} className="cal-empty" />
            ) : (
              <button
                key={index}
                type="button"
                className={`cal-day${isEdge(day) ? " cal-sel" : ""}${inRange(day) ? " cal-inrange" : ""}${iso(day) === today ? " cal-today" : ""}`}
                onClick={() => pick(day)}
              >
                {day.getDate()}
              </button>
            ))}
          </div>
          <div className="cal-foot">
            <button type="button" className="cal-clear" onClick={() => onChange("", "")}>Clear</button>
            <button type="button" className="cal-done" onClick={() => setOpen(false)}>Done</button>
          </div>
    </div>
  ) : null;

  return (
    <div className="cal-wrap">
      <button ref={triggerRef} type="button" className={`cal-trigger ${since || until ? "cal-set" : ""}`} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden><path fill="currentColor" d="M6 2v2M14 2v2M3 7h14M4 5h12a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z" fillOpacity="0" stroke="currentColor" strokeWidth="1.3" /></svg>
        {label}
      </button>
      {typeof document === "undefined" ? null : createPortal(popover, document.body)}
    </div>
  );
}
