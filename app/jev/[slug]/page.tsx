// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

/**
 * One client's Jev list check: their screening questions, a CSV drop, and a live run.
 *
 * ── Why results live in a ref and repaint once per frame ─────────────────────────────────────────
 * Several chunks stream at once and answers land at ~100 a second. Setting React state per answer would
 * re-render a table of thousands of rows a hundred times a second; instead each answer goes into a Map and a
 * single animation-frame flush repaints whatever arrived since the last one.
 *
 * ── Why the file never leaves the browser whole ──────────────────────────────────────────────────
 * It is parsed here and each row is trimmed to its profile, so only a few hundred tokens per contact are sent
 * and the original columns come back out untouched in the downloads.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import {
  MAX_ROWS,
  duplicateIndexes,
  estimateTokens,
  identify,
  isAiArkExport,
  parseCsv,
  profileFor,
  rowObject,
  toCsv,
  toWireQuestions,
} from "../../../shared/jev.mjs";
import "../../jev.css";

type Question = { key: string; label: string; type: "noul" | "choice"; instructions: string; criteria?: Record<string, string>; pass: boolean | string[] };
type QuestionSet = { questions: Question[]; thresholds: { keep: number; drop: number }; source?: string; updatedAt?: string; brainFolder?: string; brainDocuments?: string[] };
type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type Person = { name: string; title: string; company: string; linkedin: string };
type LoadedFile = { name: string; headers: string[]; rows: string[][]; format: "aiark" | "generic"; people: Person[]; profiles: unknown[]; duplicates: Set<number> };
type Status = "good" | "borderline" | "bad" | "error" | "duplicate";
type Result = { status: Status; reason: string; scores?: Record<string, number | null>; tokens?: number; cost?: number | null };
type Filter = "all" | Status;
type Notice = { kind: "ok" | "error" | "info"; text: string } | null;

/** Contacts per request, and requests in flight at once. 40 × 4 lanes × 12 server-side = ~48 concurrent. */
const CHUNK_SIZE = 40;
const LANES = 4;
/** How many rows the live table draws. The counts and downloads always cover every row. */
const VISIBLE_ROWS = 300;
/** OpenRouter's listed Jev price, used only when a response does not report its own cost. */
const PRICE_PER_TOKEN = 0.042 / 1_000_000;

const STATUS_LABEL: Record<Status, string> = { good: "Good fit", borderline: "Borderline", bad: "Bad fit", error: "Error", duplicate: "Duplicate" };
const pct = (p: number | null | undefined) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "—");
const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
const fmtDuration = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const blankQuestion = (n: number): Question => ({ key: `q${n}`, label: "New question", type: "noul", instructions: "", criteria: { true: "", false: "" }, pass: true });

function download(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/* ══ Question editor ══ */

function QuestionEditor({ value, onChange }: { value: QuestionSet; onChange: (v: QuestionSet) => void }) {
  const setQ = (idx: number, patch: Partial<Question>) => onChange({ ...value, questions: value.questions.map((q, i) => (i === idx ? { ...q, ...patch } : q)) });
  const removeQ = (idx: number) => onChange({ ...value, questions: value.questions.filter((_, i) => i !== idx) });
  const move = (idx: number, dir: -1 | 1) => {
    const arr = [...value.questions]; const j = idx + dir; if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]]; onChange({ ...value, questions: arr });
  };
  return (
    <div className="jev-editor">
      {value.questions.map((q, idx) => {
        const options = Object.entries(q.criteria ?? {});
        const passList = Array.isArray(q.pass) ? q.pass : [];
        return (
          <div className="jev-edit-q" key={idx}>
            <div className="jev-edit-top">
              <span className="jev-q-num">{idx + 1}</span>
              <input className="jev-input jev-edit-label" value={q.label} onChange={(e) => setQ(idx, { label: e.target.value })} placeholder="Short name" />
              <div className="jev-seg">
                <button type="button" className={q.type === "noul" ? "on" : ""} onClick={() => setQ(idx, { type: "noul", criteria: { true: "", false: "" }, pass: true })}>Yes / No</button>
                <button type="button" className={q.type === "choice" ? "on" : ""} onClick={() => setQ(idx, { type: "choice", criteria: { fits: "", does_not_fit: "", unclear: "The profile does not say" }, pass: ["fits"] })}>Choice</button>
              </div>
              <button type="button" className="jev-icon-btn" title="Move up" onClick={() => move(idx, -1)} disabled={idx === 0}>↑</button>
              <button type="button" className="jev-icon-btn" title="Move down" onClick={() => move(idx, 1)} disabled={idx === value.questions.length - 1}>↓</button>
              <button type="button" className="jev-icon-btn danger" title="Remove question" onClick={() => removeQ(idx)}>✕</button>
            </div>
            <textarea className="jev-input jev-textarea" rows={2} value={q.instructions} onChange={(e) => setQ(idx, { instructions: e.target.value })} placeholder="The exact question Jev answers about each contact" />
            {q.type === "noul" ? (
              <div className="jev-edit-noul">
                <label><span>Yes means</span><input className="jev-input" value={q.criteria?.true ?? ""} onChange={(e) => setQ(idx, { criteria: { ...q.criteria, true: e.target.value } })} /></label>
                <label><span>No means</span><input className="jev-input" value={q.criteria?.false ?? ""} onChange={(e) => setQ(idx, { criteria: { ...q.criteria, false: e.target.value } })} /></label>
                <div className="jev-fit-pick">
                  <span>Good fit when</span>
                  <div className="jev-seg">
                    <button type="button" className={q.pass !== false ? "on" : ""} onClick={() => setQ(idx, { pass: true })}>Yes</button>
                    <button type="button" className={q.pass === false ? "on" : ""} onClick={() => setQ(idx, { pass: false })}>No</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="jev-edit-choice">
                {options.map(([key, desc], oi) => (
                  <div className="jev-opt" key={oi}>
                    <label className="jev-fit-check" title="Counts as a good fit">
                      <input type="checkbox" checked={passList.includes(key)} onChange={(e) => setQ(idx, { pass: e.target.checked ? [...passList, key] : passList.filter((k) => k !== key) })} />
                      <span>fit</span>
                    </label>
                    <input className="jev-input jev-opt-key" value={key} onChange={(e) => {
                      const nk = e.target.value;
                      const entries = options.map(([k, d]) => (k === key ? [nk, d] : [k, d]));
                      setQ(idx, { criteria: Object.fromEntries(entries), pass: passList.map((k) => (k === key ? nk : k)) });
                    }} />
                    <input className="jev-input" value={desc} placeholder="What this option means" onChange={(e) => setQ(idx, { criteria: { ...q.criteria, [key]: e.target.value } })} />
                    <button type="button" className="jev-icon-btn danger" title="Remove option" onClick={() => {
                      const rest = options.filter(([k]) => k !== key);
                      setQ(idx, { criteria: Object.fromEntries(rest), pass: passList.filter((k) => k !== key) });
                    }}>✕</button>
                  </div>
                ))}
                <button type="button" className="jev-link-btn" onClick={() => setQ(idx, { criteria: { ...q.criteria, [`option_${options.length + 1}`]: "" } })}>+ Option</button>
              </div>
            )}
          </div>
        );
      })}
      <div className="jev-edit-foot">
        <button type="button" className="jev-link-btn" onClick={() => onChange({ ...value, questions: [...value.questions, blankQuestion(value.questions.length + 1)] })}>+ Question</button>
        <div className="jev-thresholds">
          <label><span>Keep at or above</span><input className="jev-input" type="number" min={1} max={99} value={Math.round(value.thresholds.keep * 100)} onChange={(e) => onChange({ ...value, thresholds: { ...value.thresholds, keep: Number(e.target.value) / 100 } })} />%</label>
          <label><span>Drop below</span><input className="jev-input" type="number" min={1} max={99} value={Math.round(value.thresholds.drop * 100)} onChange={(e) => onChange({ ...value, thresholds: { ...value.thresholds, drop: Number(e.target.value) / 100 } })} />%</label>
        </div>
      </div>
    </div>
  );
}

/* ══ Read-only question list ══ */

function QuestionList({ set }: { set: QuestionSet }) {
  return (
    <ol className="jev-qlist">
      {set.questions.map((q) => (
        <li key={q.key}>
          <div className="jev-q-head">
            <strong>{q.label}</strong>
            <span className="jev-q-type">{q.type === "noul" ? "Yes / No" : "Choice"}</span>
            <span className="jev-q-pass">
              Fit: {q.type === "noul" ? (q.pass === false ? "No" : "Yes") : (q.pass as string[]).join(", ")}
            </span>
          </div>
          <p>{q.instructions}</p>
          {q.type === "choice" && (
            <div className="jev-q-opts">
              {Object.entries(q.criteria ?? {}).map(([k, d]) => (
                <span key={k} className={(q.pass as string[]).includes(k) ? "is-fit" : ""} title={d}>{k}</span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/* ══ Page ══ */

export default function JevClientPage() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");

  const [client, setClient] = useState<Client | null>(null);
  const [set, setSet] = useState<QuestionSet | null>(null);
  const [jev, setJev] = useState<{ configured: boolean; model: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<QuestionSet | null>(null);
  const [busy, setBusy] = useState<"" | "drafting" | "saving">("");
  const [notice, setNotice] = useState<Notice>(null);

  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileError, setFileError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useRef(new Map<number, Result>());
  const order = useRef<number[]>([]);
  const inFlight = useRef(new Set<number>());
  const abortRef = useRef<AbortController | null>(null);
  const rafRef = useRef(0);
  const [, setVersion] = useState(0);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [timing, setTiming] = useState<{ start: number; end: number | null } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  // The question list folds away once a run starts, so the progress bar and the live table sit in view.
  const [collapsed, setCollapsed] = useState(false);
  const progressRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/jev/questions?client=${encodeURIComponent(slug)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setLoadError(payload.error || `Could not load this client (${response.status}).`); return; }
      setClient(payload.client); setSet(payload.set); setJev(payload.jev);
    } catch { setLoadError("Could not reach the server."); }
  }, [slug]);
  useEffect(() => { void load(); }, [load]);

  // The elapsed clock ticks while a run is going; nothing else needs a timer.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  const flush = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; setVersion((v) => v + 1); });
  };

  const resetResults = (loaded: LoadedFile | null) => {
    results.current = new Map();
    order.current = [];
    inFlight.current = new Set();
    if (loaded) for (const i of loaded.duplicates) results.current.set(i, { status: "duplicate", reason: "Same person appears earlier in the file" });
    setTiming(null); setRunError(""); setExpanded(null); setFilter("all");
    flush();
  };

  /* ── File ── */

  const readFile = async (f: File) => {
    setFileError("");
    if (!/\.csv$/i.test(f.name) && f.type !== "text/csv") { setFileError("That is not a CSV file."); return; }
    try {
      const { headers, rows } = parseCsv(await f.text(), { asArrays: true }) as { headers: string[]; rows: string[][] };
      if (!rows.length) { setFileError("The file has a header row but no contacts."); return; }
      if (rows.length > MAX_ROWS) { setFileError(`The file has ${rows.length.toLocaleString()} rows; the limit is ${MAX_ROWS.toLocaleString()}. Split it and run each half.`); return; }
      const format = isAiArkExport(headers) ? "aiark" : "generic";
      // Each row is expanded to an object only long enough to read it; the cells are what is kept.
      const people: Person[] = [];
      const profiles: unknown[] = [];
      for (const cells of rows) {
        const row = rowObject(headers, cells);
        people.push(identify(row, headers) as Person);
        profiles.push(profileFor(row, headers, format));
      }
      const loaded: LoadedFile = { name: f.name, headers, rows, format, people, profiles, duplicates: duplicateIndexes(people) as Set<number> };
      setFile(loaded);
      resetResults(loaded);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Could not read that file.");
    }
  };

  /* ── Questions ── */

  const sampleProfile = () => {
    if (!file) return undefined;
    // The richest of the first few rows, so the draft sees every field name a real profile can carry.
    let best: unknown = file.profiles[0];
    for (const p of file.profiles.slice(0, 25)) if (estimateTokens(p) > estimateTokens(best)) best = p;
    return best;
  };

  const draft = async () => {
    if (set?.questions.length && !window.confirm(`This replaces the ${set.questions.length} saved question${set.questions.length === 1 ? "" : "s"} for ${client?.name} with a new draft from the QC Brain. The current set cannot be recovered.`)) return;
    setBusy("drafting"); setNotice({ kind: "info", text: "Reading the QC Brain and drafting questions…" });
    try {
      const response = await fetch("/api/jev/questions/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, sample: sampleProfile() }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) { setNotice({ kind: "error", text: payload.error || `Draft failed (${response.status}).` }); return; }
      setSet(payload.set); setEditing(null);
      const docs = payload.brain?.documents?.length ? ` from ${payload.brain.documents.join(", ")}` : "";
      const skipped = payload.problems?.length ? ` ${payload.problems.length} unusable question${payload.problems.length === 1 ? " was" : "s were"} dropped.` : "";
      setNotice({ kind: "ok", text: `Drafted and saved ${payload.set.questions.length} questions${docs}. Review them before running.${skipped}` });
      if (file) resetResults(file);
    } catch { setNotice({ kind: "error", text: "Could not reach the server." }); }
    finally { setBusy(""); }
  };

  const save = async () => {
    if (!editing) return;
    setBusy("saving");
    try {
      const response = await fetch("/api/jev/questions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, set: { ...set, ...editing } }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        setNotice({ kind: "error", text: [payload.error || `Save failed (${response.status}).`, ...(payload.problems ?? [])].join(" · ") });
        return;
      }
      setSet(payload.set); setEditing(null);
      setNotice({ kind: payload.problems?.length ? "info" : "ok", text: payload.problems?.length ? `Saved. Not saved: ${payload.problems.join(" · ")}` : "Questions saved." });
      if (file) resetResults(file);
    } catch { setNotice({ kind: "error", text: "Could not reach the server." }); }
    finally { setBusy(""); }
  };

  /* ── Run ── */

  const runChunk = async (chunk: number[], signal: AbortSignal): Promise<"ok" | "fatal"> => {
    if (!file) return "fatal";
    for (const i of chunk) inFlight.current.add(i);
    flush();
    const answered = new Set<number>();
    const settle = (i: number, r: Result) => {
      answered.add(i); inFlight.current.delete(i);
      results.current.set(i, r); order.current.push(i); flush();
    };
    try {
      const response = await fetch("/api/jev/classify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: slug, rows: chunk.map((i) => ({ i, state: file.profiles[i] })) }),
        signal,
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        const message = payload.error || `Request failed (${response.status}).`;
        for (const i of chunk) settle(i, { status: "error", reason: message });
        // A missing question set or a bad request will fail every chunk the same way; stop instead.
        if (response.status === 400 || response.status === 409) { setRunError(message); return "fatal"; }
        return "ok";
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const r = JSON.parse(line);
            if (typeof r.i !== "number") continue;
            settle(r.i, r.ok ? { status: r.verdict, reason: r.reason ?? "", scores: r.scores, tokens: r.tokens, cost: r.cost } : { status: "error", reason: r.error || "Jev did not answer." });
            if (!r.ok && /OPENROUTER_API_KEY|401|403/.test(String(r.error))) { setRunError(String(r.error)); return "fatal"; }
          } catch { /* a malformed line is one lost row, reported below */ }
        }
      }
    } catch (error) {
      if (signal.aborted) { for (const i of chunk) inFlight.current.delete(i); flush(); return "fatal"; }
      const message = error instanceof Error ? error.message : "Connection dropped.";
      for (const i of chunk) if (!answered.has(i)) settle(i, { status: "error", reason: message });
      return "ok";
    }
    for (const i of chunk) if (!answered.has(i)) settle(i, { status: "error", reason: "No answer came back for this row." });
    return "ok";
  };

  const run = async (only?: number[]) => {
    if (!file || !set?.questions.length || running) return;
    const targets = only ?? file.rows.map((_, i) => i).filter((i) => !file.duplicates.has(i));
    if (!only) resetResults(file);
    else { for (const i of only) results.current.delete(i); order.current = order.current.filter((i) => !only.includes(i)); }
    const chunks: number[][] = [];
    for (let k = 0; k < targets.length; k += CHUNK_SIZE) chunks.push(targets.slice(k, k + CHUNK_SIZE));
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true); setRunError(""); setTiming({ start: Date.now(), end: null }); setNow(Date.now());
    setCollapsed(true);
    setTimeout(() => progressRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    let cursor = 0;
    let fatal = false;
    const lane = async () => {
      while (!fatal && !controller.signal.aborted && cursor < chunks.length) {
        const chunk = chunks[cursor++];
        if ((await runChunk(chunk, controller.signal)) === "fatal") { fatal = true; controller.abort(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LANES, chunks.length) }, lane));
    inFlight.current = new Set();
    abortRef.current = null;
    setRunning(false); setTiming((t) => (t ? { ...t, end: Date.now() } : t)); flush();
  };

  const stop = () => abortRef.current?.abort();

  /* ── Derived ── */

  const all = results.current;
  const counts = { good: 0, borderline: 0, bad: 0, error: 0, duplicate: 0 } as Record<Status, number>;
  let tokens = 0; let reportedCost = 0; let unpricedTokens = 0;
  for (const r of all.values()) {
    counts[r.status] += 1;
    if (r.tokens) { tokens += r.tokens; if (typeof r.cost === "number") reportedCost += r.cost; else unpricedTokens += r.tokens; }
  }
  const spent = reportedCost + unpricedTokens * PRICE_PER_TOKEN;
  const total = file?.rows.length ?? 0;
  const done = all.size;
  const toCheck = file ? total - file.duplicates.size : 0;
  const checked = done - counts.duplicate;
  const progress = total ? done / total : 0;
  const elapsed = timing ? (timing.end ?? now) - timing.start : 0;
  const rate = elapsed > 0 ? (checked / elapsed) * 1000 : 0;
  const remaining = rate > 0 ? ((toCheck - checked) / rate) * 1000 : 0;
  const errors = useMemo(() => [...all.entries()].filter(([, r]) => r.status === "error").map(([i]) => i), [all, counts.error]); // eslint-disable-line react-hooks/exhaustive-deps

  const estimate = useMemo(() => {
    if (!file || !set?.questions.length) return null;
    const questionTokens = estimateTokens(toWireQuestions(set.questions));
    let sum = 0;
    file.profiles.forEach((p, i) => { if (!file.duplicates.has(i)) sum += estimateTokens(p) + questionTokens; });
    return { tokens: sum, cost: sum * PRICE_PER_TOKEN, perRow: toCheck ? Math.round(sum / toCheck) : 0 };
  }, [file, set, toCheck]);

  const visible: number[] = (() => {
    if (!file) return [];
    if (filter === "all") {
      if (!done) return file.rows.slice(0, VISIBLE_ROWS).map((_, i) => i);
      const newest = [...order.current].reverse();
      const dupes = [...file.duplicates].filter((i) => !order.current.includes(i));
      // Newest verdicts on top so the table visibly fills as answers land; the rows still in flight sit
      // underneath rather than pinning four dozen "Checking…" rows above every result.
      return [...newest, ...[...inFlight.current], ...dupes].slice(0, VISIBLE_ROWS);
    }
    const out: number[] = [];
    for (const [i, r] of all) { if (r.status === filter) { out.push(i); if (out.length >= VISIBLE_ROWS) break; } }
    return out.sort((a, b) => a - b);
  })();
  const filteredCount = filter === "all" ? total : counts[filter];

  const exportRows = (keep: (r: Result | undefined) => boolean, label: string) => {
    if (!file || !set) return;
    const headers = ["Jev verdict", "Jev reason", ...set.questions.map((q) => `Jev: ${q.label}`), ...file.headers];
    const rows = file.rows.flatMap((cells, i) => {
      const r = all.get(i);
      if (!keep(r)) return [];
      const verdict = [r ? STATUS_LABEL[r.status] : "Not checked", r?.reason ?? "", ...set.questions.map((q) => (r?.scores ? pct(r.scores[q.key]) : ""))];
      return [[...verdict, ...cells]];
    });
    const stamp = new Date().toISOString().slice(0, 10);
    download(`${slug}-jev-${label}-${stamp}.csv`, toCsv(headers, rows));
  };

  const ready = Boolean(jev?.configured && set?.questions.length && file && !editing);
  const finished = Boolean(file && timing?.end && !running);

  /* ── Render ── */

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Jev", href: "/jev" }, { label: client?.name ?? slug }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="jev-shell jev-shell-wide">
          {loadError ? (
            <div className="jev-banner is-error">{loadError} <Link href="/jev">Back to clients</Link></div>
          ) : !client ? (
            <div className="jev-empty">Loading…</div>
          ) : (
            <>
              <div className="jev-client-head">
                <span className="jev-client-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
                  {client.logoUrl ? <img src={client.logoUrl} alt="" /> : (client.name[0] || "?").toUpperCase()}
                </span>
                <div className="jev-client-titles">
                  <Link href="/jev" className="jev-back">← All clients</Link>
                  <h1>{client.name}</h1>
                  <div className="jev-head-meta">
                    <span className={`jev-pill ${jev?.configured ? "ok" : "warn"}`}>{jev?.configured ? `Jev connected · ${jev.model}` : "Jev not connected"}</span>
                    {set?.brainFolder && <span className="jev-pill">Brain: {set.brainFolder}</span>}
                  </div>
                </div>
              </div>

              {jev && !jev.configured && (
                <div className="jev-banner is-error">OPENROUTER_API_KEY is not set on this deployment. Add it in Vercel → Settings → Environment Variables, then redeploy.</div>
              )}

              <div className="jev-grid">
                {/* ── Screening questions ── */}
                <section className="jev-panel">
                  <div className="jev-panel-head">
                    <h2>Screening questions {set?.questions.length ? <span className="jev-badge">{set.questions.length}</span> : null}</h2>
                    <div className="jev-actions">
                      {!editing && Boolean(set?.questions.length) && <button className="secondary-button" onClick={() => setCollapsed((c) => !c)}>{collapsed ? "Show" : "Hide"}</button>}
                      {!editing && <button className="secondary-button" onClick={() => void draft()} disabled={Boolean(busy) || running}>{busy === "drafting" ? "Drafting…" : set?.questions.length ? "Redraft from QC Brain" : "Draft from QC Brain"}</button>}
                      {!editing && <button className="secondary-button" onClick={() => { setCollapsed(false); setEditing(set ? structuredClone(set) : { questions: [blankQuestion(1)], thresholds: { keep: 0.6, drop: 0.35 } }); }} disabled={Boolean(busy) || running}>{set?.questions.length ? "Edit" : "Write by hand"}</button>}
                      {editing && <button className="secondary-button" onClick={() => setEditing(null)} disabled={busy === "saving"}>Cancel</button>}
                      {editing && <button className="primary-button" onClick={() => void save()} disabled={busy === "saving"}>{busy === "saving" ? "Saving…" : "Save questions"}</button>}
                    </div>
                  </div>
                  {notice && <div className={`jev-banner is-${notice.kind}`}>{notice.text}</div>}
                  {editing ? (
                    <QuestionEditor value={editing} onChange={setEditing} />
                  ) : set?.questions.length && collapsed ? (
                    <div className="jev-q-chips">{set.questions.map((q, n) => <span key={q.key}><b>{n + 1}</b>{q.label}</span>)}</div>
                  ) : set?.questions.length ? (
                    <>
                      <QuestionList set={set} />
                      <div className="jev-rule-line">
                        Good fit: every question ≥ {Math.round(set.thresholds.keep * 100)}% · Bad fit: any question &lt; {Math.round(set.thresholds.drop * 100)}% · otherwise Borderline
                        {set.updatedAt && <span> · saved {new Date(set.updatedAt).toLocaleString()}</span>}
                      </div>
                    </>
                  ) : (
                    <div className="jev-empty small">No questions yet. {file ? "Draft them now — the draft will use this file's fields." : "Upload the CSV first so the draft can see its fields, then draft from the QC Brain."}</div>
                  )}
                </section>

                {/* ── Contact list ── */}
                <section className="jev-panel">
                  <div className="jev-panel-head">
                    <h2>Contact list</h2>
                    {file && !running && <button className="secondary-button" onClick={() => inputRef.current?.click()}>Replace file</button>}
                  </div>
                  <input ref={inputRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ""; }} />
                  {!file ? (
                    <div
                      className={`jev-drop ${dragging ? "is-over" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => inputRef.current?.click()}
                      onKeyDown={(e) => { if (e.key === "Enter") inputRef.current?.click(); }}
                      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void readFile(f); }}
                    >
                      <strong>Drop a CSV here</strong>
                      <span>or click to choose one</span>
                    </div>
                  ) : (
                    <div className="jev-file">
                      <div className="jev-file-name">{file.name}</div>
                      <div className="jev-file-stats">
                        <span><b>{total.toLocaleString()}</b> contacts</span>
                        {file.duplicates.size > 0 && <span><b>{file.duplicates.size}</b> duplicates skipped</span>}
                        <span><b>{file.format === "aiark" ? "AI Ark" : "Generic"}</b> format</span>
                        {estimate && <span><b>~{estimate.perRow}</b> tokens / contact</span>}
                        {estimate && <span>est. <b>{money(estimate.cost)}</b></span>}
                      </div>
                      <details className="jev-peek">
                        <summary>What Jev sees for row 1</summary>
                        <pre>{JSON.stringify(file.profiles[0], null, 2)}</pre>
                      </details>
                    </div>
                  )}
                  {fileError && <div className="jev-banner is-error">{fileError}</div>}
                  <div className="jev-run-row">
                    {!running ? (
                      <button className="primary-button jev-run" onClick={() => void run()} disabled={!ready}>{done > counts.duplicate ? "Run again" : "Run"}</button>
                    ) : (
                      <button className="secondary-button jev-run" onClick={stop}>Stop</button>
                    )}
                    {!running && errors.length > 0 && <button className="secondary-button" onClick={() => void run(errors)}>Retry {errors.length} failed</button>}
                    {!ready && !running && (
                      <span className="jev-hint">
                        {!jev?.configured ? "Connect Jev first." : !set?.questions.length ? "Add questions first." : editing ? "Save or cancel the edit first." : !file ? "Upload a CSV." : ""}
                      </span>
                    )}
                  </div>
                </section>
              </div>

              {/* ── Progress ── */}
              {file && (done > counts.duplicate || running) && (
                <section className="jev-progress" ref={progressRef}>
                  <div className="jev-progress-top">
                    <strong>{running ? "Checking…" : finished ? "Done" : "Stopped"}</strong>
                    <span className="jev-progress-count">{done.toLocaleString()} / {total.toLocaleString()}</span>
                    <span>{fmtDuration(elapsed)}{running && remaining > 0 ? ` · ~${fmtDuration(remaining)} left` : ""}</span>
                    {rate > 0 && <span>{rate.toFixed(1)} / sec</span>}
                    <span>{tokens.toLocaleString()} tokens · {money(spent)}</span>
                  </div>
                  <div className="jev-bar" aria-label={`${Math.round(progress * 100)}% checked`}>
                    <i className="good" style={{ width: `${(counts.good / total) * 100}%` }} />
                    <i className="borderline" style={{ width: `${(counts.borderline / total) * 100}%` }} />
                    <i className="bad" style={{ width: `${(counts.bad / total) * 100}%` }} />
                    <i className="duplicate" style={{ width: `${(counts.duplicate / total) * 100}%` }} />
                    <i className="error" style={{ width: `${(counts.error / total) * 100}%` }} />
                  </div>
                  {runError && <div className="jev-banner is-error">{runError}</div>}
                  {finished && (
                    <div className="jev-downloads">
                      <button className="primary-button" onClick={() => exportRows((r) => r?.status === "good", "good-fits")} disabled={!counts.good}>Download {counts.good.toLocaleString()} good fits</button>
                      <button className="secondary-button" onClick={() => exportRows((r) => r?.status === "borderline", "borderline")} disabled={!counts.borderline}>Borderline ({counts.borderline.toLocaleString()})</button>
                      <button className="secondary-button" onClick={() => exportRows((r) => r?.status === "bad" || r?.status === "duplicate", "removed")} disabled={!counts.bad && !counts.duplicate}>Removed ({(counts.bad + counts.duplicate).toLocaleString()})</button>
                      <button className="secondary-button" onClick={() => exportRows(() => true, "all")}>Everything, with verdicts</button>
                    </div>
                  )}
                </section>
              )}

              {/* ── Rows ── */}
              {file && (
                <section className="jev-table-wrap">
                  <div className="jev-filters">
                    {(["all", "good", "borderline", "bad", "duplicate", "error"] as Filter[]).map((f) => (
                      (f === "all" || counts[f as Status] > 0) && (
                        <button key={f} className={`jev-filter ${f} ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
                          {f === "all" ? "All" : STATUS_LABEL[f as Status]} <b>{(f === "all" ? total : counts[f as Status]).toLocaleString()}</b>
                        </button>
                      )
                    ))}
                    {filteredCount > VISIBLE_ROWS && <span className="jev-hint">Showing {filter === "all" && done ? "the latest" : "the first"} {VISIBLE_ROWS} of {filteredCount.toLocaleString()} — downloads include every row.</span>}
                  </div>
                  <div className="jev-table">
                    <div className="jev-tr jev-th">
                      <span>#</span><span>Contact</span><span>Company</span><span>Verdict</span><span>Why</span>
                    </div>
                    {visible.map((i) => {
                      const p = file.people[i];
                      const r = all.get(i);
                      const status = r?.status ?? (inFlight.current.has(i) ? "checking" : "pending");
                      const open = expanded === i;
                      return (
                        <div key={i} className={`jev-row ${open ? "open" : ""}`}>
                          <div className={`jev-tr is-${status}`} role="button" tabIndex={0} onClick={() => setExpanded(open ? null : i)} onKeyDown={(e) => { if (e.key === "Enter") setExpanded(open ? null : i); }}>
                            <span className="jev-idx">{i + 1}</span>
                            <span className="jev-person">
                              <i>{initials(p.name)}</i>
                              <span><strong>{p.name}</strong><small>{p.title}</small></span>
                            </span>
                            <span className="jev-company">{p.company}</span>
                            <span><em className={`jev-verdict ${status}`}>{status === "checking" ? "Checking…" : status === "pending" ? "Waiting" : STATUS_LABEL[status as Status]}</em></span>
                            <span className="jev-why">{r?.reason}</span>
                          </div>
                          {open && (
                            <div className="jev-detail">
                              {r?.scores && set && (
                                <div className="jev-scores">
                                  {set.questions.map((q) => {
                                    const s = r.scores?.[q.key];
                                    const tone = typeof s !== "number" ? "none" : s >= set.thresholds.keep ? "good" : s < set.thresholds.drop ? "bad" : "borderline";
                                    return (
                                      <div key={q.key} className="jev-score">
                                        <span>{q.label}</span>
                                        <div className="jev-score-track"><i className={tone} style={{ width: `${typeof s === "number" ? s * 100 : 0}%` }} /></div>
                                        <b>{pct(s)}</b>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {p.linkedin && <a href={/^https?:/i.test(p.linkedin) ? p.linkedin : `https://${p.linkedin}`} target="_blank" rel="noreferrer" className="jev-li">LinkedIn ↗</a>}
                              <details className="jev-peek"><summary>What Jev saw</summary><pre>{JSON.stringify(file.profiles[i], null, 2)}</pre></details>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </section>
    </div>
  );
}
