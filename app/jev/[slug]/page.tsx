// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/*
 * eslint-disable react-hooks/refs, react-hooks/purity — deliberate, see "Why results live in a ref" below:
 * the run's results, stages and log are mutable stores written ~100 times a second and read during render,
 * with one requestAnimationFrame tick per frame to repaint. Moving them into state re-renders per answer, which
 * is the lag this design exists to avoid. Date.now() in render is the elapsed clock, which ticks on purpose.
 */
/* eslint-disable react-hooks/refs, react-hooks/purity */

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
  COLUMN_ROLES,
  MAX_COMPANY_ROWS,
  MAX_ROWS,
  addTags,
  mergeProposals,
  buildCompanyProfile,
  buildProfile,
  duplicateIndexes,
  estimateTokens,
  identifyCompany,
  identifyWith,
  missingFields,
  parseCsv,
  planColumns,
  planSummary,
  questionFieldRefs,
  toCsv,
  toTagWire,
  toWireQuestions,
} from "../../../shared/jev.mjs";
import { DescribeBox, SuggestPanel, TagEditor, TagList, type Suggestion, type TagSet } from "./tags";
import { IcpBox, type Icp } from "./icp";
import { freshStats, runPipeline, type EnrichMode, type Enriched, type Outcome, type Stage } from "./pipeline";
import { ActivityLog, EnrichControl, StageCards, type Detection, type LogLine } from "./pipeline-view";
import { missingData, scrapeTarget } from "../../../shared/enrich.mjs";
import "../../jev.css";

type Kind = "must" | "exclude" | "signal";
type Question = { key: string; label: string; type: "noul" | "choice"; instructions: string; criteria?: Record<string, string>; pass: boolean | string[]; kind?: Kind; neutral?: string[] };
const KIND_LABEL: Record<Kind, string> = { must: "Must-have", exclude: "Exclusion", signal: "Signal" };
const kindOf = (q: Question): Kind => q.kind ?? (q.type === "noul" && q.pass === false ? "exclude" : "must");
type QuestionSet = { questions: Question[]; thresholds: { keep: number; drop: number }; icp?: Icp; source?: string; updatedAt?: string; brainFolder?: string; brainDocuments?: string[]; brief?: string };
type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type Person = { name: string; title: string; company: string; linkedin: string };
type PlanColumn = { header: string; idx: number; role: string; why?: string; index?: number; field?: string; overridden?: boolean; filled: number };
type Plan = { columns: PlanColumn[]; experienceHasCurrent: boolean; experienceHasEnd: boolean };
type LoadedFile = { name: string; mode: Mode; headers: string[]; rows: string[][]; plan: Plan; overrides: Record<string, string>; people: Person[]; profiles: unknown[]; duplicates: Set<number> };
/** Rows the column plan is detected from — enough to see a column's real contents, cheap on a 10k-row file. */
const PLAN_SAMPLE = 300;
const ROLE_GROUPS: [string, string[]][] = [
  ["Person", ["title", "headline", "about", "seniority", "department", "location", "skills"]],
  ["Company", ["company", "company_industry", "company_employees", "company_description", "company_products", "company_funding", "company_revenue", "company_location", "company_type", "company_locations"]],
  ["Job history", ["experience", "experience_json"]],
  ["Identity (never sent)", ["name", "first_name", "last_name", "linkedin", "website", "company_linkedin"]],
  ["Other", ["other", "ignore"]],
];
const IDENTITY = new Set(["name", "first_name", "last_name", "linkedin", "website", "company_linkedin"]);
const roleLabel = (c: PlanColumn) => (c.role === "experience" && c.field ? `Job ${c.index} · ${c.field}` : (COLUMN_ROLES as Record<string, string>)[c.role] ?? c.role);
type Mode = "contacts" | "companies";
type Status = "good" | "borderline" | "bad" | "tagged" | "review" | "error" | "duplicate";
type Ranked = { tag: string; label: string; p: number };
type Review = { kind: "existing" | "new" | "unplaced"; confidence: string; reason: string; jevLabel?: string };
type Result = { review?: Review; score?: number | null; status: Status; reason: string; scores?: Record<string, number | null>; tag?: string; label?: string; confidence?: number; runnerUp?: Ranked | null; top?: Ranked[]; tokens?: number; cost?: number | null; note?: string; enriched?: boolean; firstStatus?: string };
/** "all", a status, or "tag:<key>" for one company tag. */
type Filter = string;
type Notice = { kind: "ok" | "error" | "info"; text: string } | null;

const ENRICH_COLUMNS: Record<Mode, [string, string][]> = {
  companies: [["source", "Jev enriched from"], ["what_they_do", "Enriched: what they do"], ["industry", "Enriched: industry"], ["customers", "Enriched: customers"], ["organization_type", "Enriched: organization type"], ["evidence", "Enriched: evidence"]],
  contacts: [["source", "Jev enriched from"], ["headline", "Enriched: headline"], ["current_title", "Enriched: current title"], ["current_company", "Enriched: current company"], ["current_roles", "Enriched: current roles"], ["seniority", "Enriched: seniority"], ["company_description", "Enriched: company description"]],
};
const STAGE_LABEL: Record<Stage, string> = { first: "First pass…", scrape: "Scraping…", structure: "Structuring…", final: "Final pass…" };
/** Jev's verdict line, as the classify route streams it, turned into a table row's result. */
const toResult = (mode: Mode, r: Record<string, unknown> | null | undefined): Result => {
  if (!r || !r.ok) return { status: "error", reason: String(r?.error || "Jev did not answer.") };
  if (mode === "companies") return { status: r.status as Status, reason: String(r.reason ?? ""), tag: r.tag as string, label: r.label as string, confidence: r.confidence as number, runnerUp: r.runnerUp as Ranked | null, top: r.top as Ranked[], tokens: r.tokens as number, cost: r.cost as number | null };
  return { status: r.verdict as Status, reason: String(r.reason ?? ""), scores: r.scores as Record<string, number | null>, score: typeof r.score === "number" ? r.score : null, tokens: r.tokens as number, cost: r.cost as number | null };
};
/** How many rows the live table draws. The counts and downloads always cover every row. */
const VISIBLE_ROWS = 300;
/** OpenRouter's listed Jev price, used only when a response does not report its own cost. */
const PRICE_PER_TOKEN = 0.042 / 1_000_000;

const STATUS_LABEL: Record<Status, string> = { good: "Good fit", borderline: "Borderline", bad: "Bad fit", tagged: "Tagged", review: "Needs review", error: "Error", duplicate: "Duplicate" };
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
                <button type="button" className={q.type === "choice" ? "on" : ""} onClick={() => setQ(idx, { type: "choice", criteria: { fits: "", does_not_fit: "", unclear: "The profile does not say" }, pass: ["fits"], neutral: ["unclear"] })}>Choice</button>
              </div>
              <div className="jev-seg" title="What this question does to the verdict">
                {(["must", "exclude", "signal"] as Kind[]).map((k) => (
                  <button key={k} type="button" className={kindOf(q) === k ? "on" : ""} onClick={() => setQ(idx, { kind: k })}>{KIND_LABEL[k]}</button>
                ))}
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
                      <input type="checkbox" checked={passList.includes(key)} onChange={(e) => setQ(idx, { pass: e.target.checked ? [...passList, key] : passList.filter((k) => k !== key), neutral: (q.neutral ?? []).filter((k) => k !== key) })} />
                      <span>fit</span>
                    </label>
                    <label className="jev-fit-check" title="Can't tell — counts for nothing either way">
                      <input type="checkbox" checked={(q.neutral ?? []).includes(key)} onChange={(e) => setQ(idx, { neutral: e.target.checked ? [...(q.neutral ?? []), key] : (q.neutral ?? []).filter((k) => k !== key), pass: passList.filter((k) => k !== key) })} />
                      <span>?</span>
                    </label>
                    <input className="jev-input jev-opt-key" value={key} onChange={(e) => {
                      const nk = e.target.value;
                      const entries = options.map(([k, d]) => (k === key ? [nk, d] : [k, d]));
                      setQ(idx, { criteria: Object.fromEntries(entries), pass: passList.map((k) => (k === key ? nk : k)), neutral: (q.neutral ?? []).map((k) => (k === key ? nk : k)) });
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

function QuestionList({ set, missing }: { set: QuestionSet; missing: Record<string, string[]> }) {
  return (
    <ol className="jev-qlist">
      {set.questions.map((q) => (
        <li key={q.key} className={missing[q.key] ? "has-gap" : ""}>
          <div className="jev-q-head">
            <strong>{q.label}</strong>
            <span className={`jev-q-kind ${kindOf(q)}`}>{KIND_LABEL[kindOf(q)]}</span>
            <span className="jev-q-type">{q.type === "noul" ? "Yes / No" : "Choice"}</span>
            <span className="jev-q-pass">
              Fit: {q.type === "noul" ? (q.pass === false ? "No" : "Yes") : (q.pass as string[]).join(", ")}
            </span>
          </div>
          <p>{q.instructions}</p>
          {q.type === "choice" && (
            <div className="jev-q-opts">
              {Object.entries(q.criteria ?? {}).map(([k, d]) => (
                <span key={k} className={(q.pass as string[]).includes(k) ? "is-fit" : (q.neutral ?? []).includes(k) ? "is-neutral" : ""} title={d}>{k}</span>
              ))}
            </div>
          )}
          {missing[q.key] && (
            <div className="jev-gap">Most contacts in this file have no {missing[q.key].map((f) => `\`${f}\``).join(", ")} — Jev will be answering this one blind.</div>
          )}
        </li>
      ))}
    </ol>
  );
}

/* ══ Column plan ══ */

/**
 * How each column of this file was read, with a role picker to correct it. Used columns first, then the ones
 * that identify the person (shown in the table, never sent), then everything ignored — with the reason, so an
 * engineer can see at a glance that "Company Domain" was dropped because it is a link, not because it was missed.
 */
function ColumnPanel({ file, onChange, disabled }: { file: LoadedFile; onChange: (header: string, role: string) => void; disabled: boolean }) {
  const sampleOf = (idx: number) => { for (const cells of file.rows.slice(0, PLAN_SAMPLE)) { const v = (cells[idx] ?? "").trim(); if (v) return v.length > 70 ? `${v.slice(0, 70)}…` : v; } return ""; };
  const groups: [string, PlanColumn[]][] = [
    ["Sent to Jev", file.plan.columns.filter((c) => c.role !== "ignore" && !IDENTITY.has(c.role))],
    [file.mode === "companies" ? "Identifies the company — used to spot duplicates, never sent" : "Identifies the person — shown here, never sent", file.plan.columns.filter((c) => IDENTITY.has(c.role))],
    ["Ignored", file.plan.columns.filter((c) => c.role === "ignore")],
  ];
  const [used, identity, ignored] = groups.map(([, cols]) => cols.length);
  return (
    <details className="jev-peek jev-columns">
      <summary>Columns: {used} sent · {identity} identity · {ignored} ignored</summary>
      {groups.map(([label, cols]) => cols.length > 0 && (
        <div key={label} className="jev-col-group">
          <div className="jev-col-group-head">{label} <b>{cols.length}</b></div>
          {cols.map((c) => (
            <div key={c.header} className={`jev-col ${c.overridden ? "is-overridden" : ""}`}>
              <span className="jev-col-name" title={c.header}>{c.header}</span>
              <span className="jev-col-sample" title={sampleOf(c.idx)}>{sampleOf(c.idx) || <em>empty</em>}</span>
              <select className="jev-input jev-col-role" value={c.role} disabled={disabled} onChange={(e) => onChange(c.header, e.target.value)} aria-label={`What ${c.header} holds`}>
                {ROLE_GROUPS.map(([g, roles]) => (
                  <optgroup key={g} label={g}>
                    {roles.map((r) => <option key={r} value={r}>{r === c.role && c.role === "experience" ? roleLabel(c) : (COLUMN_ROLES as Record<string, string>)[r]}</option>)}
                  </optgroup>
                ))}
              </select>
              {c.role === "ignore" && c.why && <span className="jev-col-why">{c.why}</span>}
            </div>
          ))}
        </div>
      ))}
    </details>
  );
}

/* ══ Page ══ */

export default function JevClientPage() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");

  const [client, setClient] = useState<Client | null>(null);
  const [set, setSet] = useState<QuestionSet | null>(null);
  const [tags, setTags] = useState<TagSet | null>(null);
  const [editingTags, setEditingTags] = useState<TagSet | null>(null);
  // Tags proposed from a run's "Other" pile, and — once some are added — the rows worth re-tagging with them.
  const [suggestion, setSuggestion] = useState<{ suggestions: Suggestion[]; outOfScope: string[] } | null>(null);
  const [retag, setRetag] = useState<number[]>([]);
  // Claude's second opinion on Other / Needs review: progress while it runs, and the new tags it proposed.
  const [review, setReview] = useState<{ done: number; total: number; cost: number } | null>(null);
  const [proposals, setProposals] = useState<Suggestion[] | null>(null);
  const newTagLabels = useRef(new Map<string, string>());
  const [mode, setModeState] = useState<Mode>("contacts");
  const [jev, setJev] = useState<{ configured: boolean; model: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<QuestionSet | null>(null);
  const [busy, setBusy] = useState<"" | "drafting" | "saving" | "building">("");
  const [notice, setNotice] = useState<Notice>(null);

  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileError, setFileError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useRef(new Map<number, Result>());
  const order = useRef<number[]>([]);
  // Where each unsettled row is in the pipeline; a row leaves this map when its final verdict lands.
  const stages = useRef(new Map<number, Stage>());
  const stats = useRef(freshStats());
  const logLines = useRef<LogLine[]>([]);
  // Scraped-and-structured profiles survive re-runs of the same file, so changing a question never pays to
  // scrape a row twice. Cleared whenever the rows themselves change.
  const enrichedRef = useRef(new Map<number, Enriched>());
  const [enrichMode, setEnrichMode] = useState<EnrichMode>("auto");
  // True when the server has been redeployed since this tab loaded: the page's pipeline code may no longer match
  // the routes it calls, so runs are blocked until a reload.
  const [stale, setStale] = useState(false);
  const [enrichCfg, setEnrichCfg] = useState<{ aiArk: boolean; jina: boolean; structureModel: string; structureRpm: number; llm: boolean } | null>(null);
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
      setClient(payload.client); setSet(payload.set); setTags(payload.tags ?? null); setJev(payload.jev); setEnrichCfg(payload.enrich ?? null);
      if (payload.build && process.env.NEXT_PUBLIC_BUILD_ID && payload.build !== process.env.NEXT_PUBLIC_BUILD_ID) setStale(true);
    } catch { setLoadError("Could not reach the server."); }
  }, [slug]);
  useEffect(() => { void load(); }, [load]);

  // The list type lives in the URL (?mode=companies) so a link to a client's company tagging opens on it.
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("mode");
    if (m === "companies") setModeState("companies");
  }, []);

  // A 100k-company run takes a quarter of an hour in this tab; closing it by accident would lose the lot.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

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
    stages.current = new Map();
    stats.current = freshStats();
    logLines.current = [];
    if (loaded) for (const i of loaded.duplicates) results.current.set(i, { status: "duplicate", reason: loaded.mode === "companies" ? "Same company appears earlier in the file" : "Same person appears earlier in the file" });
    setTiming(null); setRunError(""); setExpanded(null); setFilter("all");
    flush();
  };

  /* ── File ── */

  /**
   * Read every column for what it means, then build each contact's profile from that plan. Re-run with
   * overrides when an engineer corrects a column, so the same code path produces what the run sends.
   */
  const buildFile = (name: string, headers: string[], rows: string[][], overrides: Record<string, string>, as: Mode = mode): LoadedFile => {
    const plan = planColumns(headers, rows.slice(0, PLAN_SAMPLE), overrides) as Plan;
    const people: Person[] = [];
    const profiles: unknown[] = [];
    for (const cells of rows) {
      people.push((as === "companies" ? identifyCompany(cells, plan) : identifyWith(cells, plan)) as Person);
      profiles.push(as === "companies" ? buildCompanyProfile(cells, plan) : buildProfile(cells, plan));
    }
    enrichedRef.current = new Map();
    return { name, mode: as, headers, rows, plan, overrides, people, profiles, duplicates: duplicateIndexes(people) as Set<number> };
  };

  /** Switching list type clears the loaded file: a company list read as contacts is a table of "(no name)" rows. */
  const setMode = (next: Mode) => {
    if (running || next === mode) return;
    setModeState(next);
    const url = new URL(window.location.href);
    if (next === "companies") url.searchParams.set("mode", "companies"); else url.searchParams.delete("mode");
    window.history.replaceState(null, "", url);
    setNotice(null); setEditing(null); setEditingTags(null); setCollapsed(false);
    if (file) { setFile(null); setFileError(""); resetResults(null); enrichedRef.current = new Map(); }
  };

  const setColumnRole = (header: string, role: string) => {
    if (!file || running) return;
    const overrides = { ...file.overrides, [header]: role };
    const next = buildFile(file.name, file.headers, file.rows, overrides, file.mode);
    setFile(next);
    resetResults(next);
  };

  const readFile = async (f: File) => {
    setFileError("");
    if (!/\.csv$/i.test(f.name) && f.type !== "text/csv") { setFileError("That is not a CSV file."); return; }
    try {
      const { headers, rows } = parseCsv(await f.text(), { asArrays: true }) as { headers: string[]; rows: string[][] };
      if (!rows.length) { setFileError("The file has a header row but no rows."); return; }
      const limit = mode === "companies" ? MAX_COMPANY_ROWS : MAX_ROWS;
      if (rows.length > limit) { setFileError(`The file has ${rows.length.toLocaleString()} rows; the limit for a ${mode === "companies" ? "company" : "contact"} list is ${limit.toLocaleString()}. Split it and run each part.`); return; }
      const loaded = buildFile(f.name, headers, rows, {});
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

  const buildSetup = async (description: string, icp?: Record<string, unknown>) => {
    const existing = mode === "companies" ? tags?.tags.length : set?.questions.length;
    if (existing && !window.confirm(`This replaces ${client?.name}'s saved ${mode === "companies" ? `tag set (${existing} tags)` : `screening questions (${existing})`} with a new setup built from your description. The current one cannot be recovered.`)) return;
    setBusy("building"); setNotice({ kind: "info", text: mode === "companies" ? "Writing a description for every tag…" : "Turning your description into screening questions…" });
    try {
      const response = await fetch("/api/jev/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, mode, description, icp, sample: sampleProfile() }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) { setNotice({ kind: "error", text: payload.error || `Build failed (${response.status}).` }); return; }
      if (mode === "companies") { setTags(payload.set); setEditingTags(null); } else { setSet(payload.set); setEditing(null); }
      if (mode === "companies" && Array.isArray(payload.pendingDescriptions) && payload.pendingDescriptions.length) {
        await describePending(payload.set, payload.pendingDescriptions);
        return;
      }
      setCollapsed(false);
      const n = mode === "companies" ? payload.set.tags.length : payload.set.questions.length;
      const notes = payload.problems?.length ? ` ${payload.problems.join(" · ")}.` : "";
      setNotice({ kind: "ok", text: `Built and saved ${n} ${mode === "companies" ? "tags" : "questions"}. Check them below before running.${notes}` });
      if (file) resetResults(file);
    } catch { setNotice({ kind: "error", text: "Could not reach the server." }); }
    finally { setBusy(""); }
  };

  /** Rows the last run put in Other or left for review — the ones new tags could change. */
  const otherRows = () => [...results.current.entries()].filter(([, r]) => (r.status === "tagged" || r.status === "review") && (r.tag === "other" || r.status === "review")).map(([i]) => i);

  const suggestFromOther = async () => {
    if (!file) return;
    const rows = [...results.current.entries()].filter(([, r]) => r.tag === "other" && (r.status === "tagged" || r.status === "review")).map(([i]) => i);
    setBusy("building"); setSuggestion(null); setNotice({ kind: "info", text: `Looking for patterns in the ${rows.length} companies in Other…` });
    try {
      const items = rows.slice(0, 250).map((i) => ({ profile: enrichedRef.current.get(i)?.profile ?? file.profiles[i], runnerUp: results.current.get(i)?.runnerUp?.label }));
      const response = await fetch("/api/jev/tags/suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, items }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) { setNotice({ kind: "error", text: payload.error || `Suggestion failed (${response.status}).` }); return; }
      setSuggestion({ suggestions: payload.suggestions ?? [], outOfScope: payload.outOfScope ?? [] });
      setNotice(null); setCollapsed(false);
    } catch { setNotice({ kind: "error", text: "Could not reach the server." }); }
    finally { setBusy(""); }
  };

  /** Save the chosen suggestions into the tag set without clearing the run, so only the affected rows re-run. */
  const addSuggested = async (chosen: Suggestion[]) => {
    if (!tags || !chosen.length) return;
    setBusy("saving");
    try {
      const next = addTags(tags, chosen.map((c) => ({ label: c.label, description: c.description })));
      const response = await fetch("/api/jev/questions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, kind: "tags", set: { ...tags, ...next } }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) { setNotice({ kind: "error", text: payload.error || `Save failed (${response.status}).` }); return; }
      setTags(payload.set); setSuggestion(null);
      const rows = otherRows();
      setRetag(rows);
      setNotice({ kind: "ok", text: `Added ${chosen.length} tag${chosen.length === 1 ? "" : "s"}. Re-tag the ${rows.length} companies in Other and Needs review to use them.` });
    } catch { setNotice({ kind: "error", text: "Could not reach the server." }); }
    finally { setBusy(""); }
  };

  /**
   * Fill in descriptions for a typed tag list, 25 tags a request, four at a time, then save the set once. The
   * names are already saved, so a failure here leaves a usable (if less precise) tag set rather than nothing.
   */
  const describePending = async (saved: TagSet, pending: string[]) => {
    const SLICE = 25;
    const all = saved.tags.map((t) => t.label);
    const slices: string[][] = [];
    for (let k = 0; k < pending.length; k += SLICE) slices.push(pending.slice(k, k + SLICE));
    const found: Record<string, string> = {};
    let done = 0; let failed = 0; let next = 0;
    setNotice({ kind: "info", text: `Saved ${saved.tags.length} tags. Writing descriptions… 0 of ${pending.length}` });
    await Promise.all(Array.from({ length: Math.min(4, slices.length) }, async () => {
      while (next < slices.length) {
        const slice = slices[next++];
        try {
          const response = await fetch("/api/jev/tags/describe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, labels: slice, all }) });
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload.ok) Object.assign(found, payload.descriptions ?? {}); else failed += slice.length;
        } catch { failed += slice.length; }
        done += slice.length;
        setTags((t) => (t ? { ...t, tags: t.tags.map((tag) => (found[tag.label] && !tag.description ? { ...tag, description: found[tag.label] } : tag)) } : t));
        setNotice({ kind: "info", text: `Saved ${saved.tags.length} tags. Writing descriptions… ${done} of ${pending.length}` });
      }
    }));
    const withDescriptions = { ...saved, tags: saved.tags.map((t) => (found[t.label] && !t.description ? { ...t, description: found[t.label] } : t)) };
    try {
      const response = await fetch("/api/jev/questions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, kind: "tags", set: withDescriptions }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) { setNotice({ kind: "error", text: payload.error || `Saving descriptions failed (${response.status}).` }); return; }
      setTags(payload.set);
      const missing = payload.set.tags.filter((t: { description: string; key: string }) => !t.description && t.key !== "other").length;
      setNotice({ kind: missing ? "info" : "ok", text: `Saved ${payload.set.tags.length} tags with descriptions${missing ? ` — ${missing} still have none${failed ? " (some batches failed; build again to retry just those)" : ""}` : ""}. Check them below before running.` });
    } catch { setNotice({ kind: "error", text: "Could not reach the server." }); }
  };

  /**
   * Send the rows Jev could not place to Claude, 15 a request, three at a time. Each answer updates its row as it
   * lands: an existing tag, a proposed new tag (collected for the team to adopt), or left as it was with a reason.
   */
  const reviewWithClaude = async () => {
    if (!file || running || review) return;
    const rows = [...results.current.entries()].filter(([, r]) => (r.status === "review" || (r.status === "tagged" && r.tag === "other")) && !r.review).map(([i]) => i);
    if (!rows.length) return;
    const outcomes = new Map<number, Record<string, unknown>>();
    let done = 0; let cost = 0; let failed = 0; let lastError = "";
    setReview({ done: 0, total: rows.length, cost: 0 }); setProposals(null);
    const batches: number[][] = [];
    // Eight a request: a review answer carries a reason per company, and eight keeps it well inside the output
    // cap and the 60s ceiling; the server still halves a batch whose answer comes back cut off.
    for (let k = 0; k < rows.length; k += 8) batches.push(rows.slice(k, k + 8));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const items = batch.map((i) => ({ i, profile: enrichedRef.current.get(i)?.profile ?? file.profiles[i], top: results.current.get(i)?.top }));
          const response = await fetch("/api/jev/tags/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, items }) }).catch(() => null);
          const payload = response ? await response.json().catch(() => ({})) : {};
          if (response?.status === 429 && attempt < 5) { pushLog("warn", `OpenRouter rate limit — holding ${batch.length} companies for 20s`); await new Promise((r) => setTimeout(r, 20_000)); continue; }
          if (!response?.ok || !payload.ok) { failed += batch.length; lastError = String(payload?.error ?? `HTTP ${response?.status ?? "no response"}`); pushLog("error", `Claude review failed for ${batch.length} companies: ${lastError}`); break; }
          cost += Number(payload.cost) || 0;
          for (const o of payload.results ?? []) {
            const i = Number(o.i); const prev = results.current.get(i);
            if (!prev) continue;
            outcomes.set(i, o);
            const rv: Review = { kind: o.kind, confidence: o.confidence, reason: o.reason, jevLabel: prev.label };
            if (o.kind === "unplaced") results.current.set(i, { ...prev, review: rv });
            else {
              if (o.kind === "new") newTagLabels.current.set(o.tag, o.label);
              results.current.set(i, { ...prev, status: "tagged", tag: o.tag, label: o.label, review: rv });
            }
          }
          const placed = (payload.results ?? []).filter((o: { kind: string }) => o.kind !== "unplaced").length;
          pushLog("ok", `Claude placed ${placed} of ${batch.length}${placed < batch.length ? `, ${batch.length - placed} left as they were` : ""}`);
          break;
        }
        done += batch.length;
        setReview({ done, total: rows.length, cost });
        flush();
      }
    }));
    const merged = mergeProposals(outcomes) as Array<{ key: string; label: string; description: string; rows: number[] }>;
    setProposals(merged.map((m) => ({ label: m.label, description: m.description, count: m.rows.length, examples: m.rows.slice(0, 5).map((i) => file.people[i]?.name ?? "") })));
    setReview(null);
    const placed = [...outcomes.values()].filter((o) => o.kind !== "unplaced").length;
    setNotice({ kind: failed ? "info" : "ok", text: `Claude reviewed ${rows.length.toLocaleString()} companies — placed ${placed.toLocaleString()}${merged.length ? `, proposing ${merged.length} new tag${merged.length === 1 ? "" : "s"}` : ""}${failed ? `; ${failed} could not be reviewed (${lastError}) — click Review again to retry them` : ""} · ${money(cost)}` });
    setCollapsed(false);
  };

  /** Adopt Claude's proposed tags into the saved set. Rows already carry them, so nothing needs to re-run. */
  const adoptProposals = async (chosen: Suggestion[]) => {
    if (!tags || !chosen.length) return;
    setBusy("saving");
    try {
      const next = addTags(tags, chosen.map((c) => ({ label: c.label, description: c.description })));
      const response = await fetch("/api/jev/questions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, kind: "tags", set: { ...tags, ...next } }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) { setNotice({ kind: "error", text: payload.error || `Save failed (${response.status}).` }); return; }
      setTags(payload.set); setProposals(null);
      setNotice({ kind: "ok", text: `Added ${chosen.length} tag${chosen.length === 1 ? "" : "s"} to the tag set — future runs will use them.` });
    } catch { setNotice({ kind: "error", text: "Could not reach the server." }); }
    finally { setBusy(""); }
  };

  const saveTags = async () => {
    if (!editingTags) return;
    setBusy("saving");
    try {
      const response = await fetch("/api/jev/questions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: slug, kind: "tags", set: { ...tags, ...editingTags } }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) { setNotice({ kind: "error", text: [payload.error || `Save failed (${response.status}).`, ...(payload.problems ?? [])].join(" · ") }); return; }
      setTags(payload.set); setEditingTags(null);
      setNotice({ kind: payload.problems?.length ? "info" : "ok", text: payload.problems?.length ? `Saved. ${payload.problems.join(" · ")}` : "Tags saved." });
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

  const pushLog = (kind: LogLine["kind"], text: string) => {
    logLines.current.push({ t: Date.now(), kind, text });
    if (logLines.current.length > 2_000) logLines.current.splice(0, logLines.current.length - 2_000);
    flush();
  };

  /** The fields this client's questions name, so a row missing one of them counts as thin. */
  const requiredFields = useMemo(() => (mode === "contacts" && set?.questions.length ? [...new Set(set.questions.flatMap((q) => questionFieldRefs(q) as string[]))] : []), [mode, set]);

  const run = async (only?: number[]) => {
    // Re-check the build before spending anything: a tab open across a deploy is exactly when this bites.
    try {
      const probe = await fetch(`/api/jev/questions?client=${encodeURIComponent(slug)}`, { cache: "no-store" }).then((r) => r.json());
      if (probe?.build && process.env.NEXT_PUBLIC_BUILD_ID && probe.build !== process.env.NEXT_PUBLIC_BUILD_ID) { setStale(true); return; }
    } catch { /* offline checks fall through to the run's own errors */ }
    if (!file || running || !(file.mode === "companies" ? tags?.tags.length : set?.questions.length)) return;
    const targets = only ?? file.rows.map((_, i) => i).filter((i) => !file.duplicates.has(i));
    if (!only) resetResults(file);
    else { const retry = new Set(only); for (const i of only) results.current.delete(i); order.current = order.current.filter((i) => !retry.has(i)); }
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true); setRunError(""); setTiming({ start: Date.now(), end: null }); setNow(Date.now());
    setCollapsed(true);
    setTimeout(() => progressRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    const fm = file.mode;
    const { fatal } = await runPipeline({
      client: slug,
      mode: fm,
      enrichMode,
      aiArk: Boolean(enrichCfg?.aiArk),
      structureRpm: enrichCfg?.structureRpm ?? 18,
      signal: controller.signal,
      stats: stats.current,
      profileOf: (i) => file.profiles[i],
      nameOf: (i) => file.people[i]?.name ?? `row ${i + 1}`,
      targetOf: (i) => scrapeTarget(fm, file.people[i]) as string,
      missingOf: (_i, profile) => missingData(fm, profile, requiredFields) as string[],
      cached: enrichedRef.current,
      onStage: (i, stage) => { if (stage) stages.current.set(i, stage); else stages.current.delete(i); },
      onEnriched: () => {},
      onSettle: (o: Outcome) => {
        const first = o.first ? toResult(fm, o.first) : null;
        results.current.set(o.i, { ...toResult(fm, o.result), note: o.note, enriched: o.enriched, firstStatus: first && o.enriched ? (first.label ?? STATUS_LABEL[first.status]) : undefined });
        order.current.push(o.i);
        flush();
      },
      onLog: pushLog,
      onChange: flush,
    }, targets);
    if (fatal) setRunError(fatal);
    if (controller.signal.aborted) pushLog("warn", "Stopped by hand");
    else pushLog("ok", `Run finished — ${results.current.size.toLocaleString()} rows settled`);
    stages.current = new Map();
    abortRef.current = null;
    setRunning(false); setTiming((t) => (t ? { ...t, end: Date.now() } : t)); flush();
  };

  /** What detection finds in this file before anything is spent: thin rows, and which of them can be scraped. */
  const detection = useMemo<Detection | null>(() => {
    if (!file) return null;
    let thin = 0; let scrapeable = 0; let noTarget = 0;
    file.profiles.forEach((p, i) => {
      if (file.duplicates.has(i)) return;
      const target = scrapeTarget(file.mode, file.people[i]);
      if (!target) noTarget += 1;
      if ((missingData(file.mode, p, requiredFields) as string[]).length) { thin += 1; if (target) scrapeable += 1; }
    });
    return { rows: file.rows.length - file.duplicates.size, thin, scrapeable, noTarget, blocked: file.mode === "contacts" && !enrichCfg?.aiArk };
  }, [file, requiredFields, enrichCfg]);

  const stop = () => abortRef.current?.abort();

  /* ── Derived ── */

  const all = results.current;
  const counts = { good: 0, borderline: 0, bad: 0, tagged: 0, review: 0, error: 0, duplicate: 0 } as Record<Status, number>;
  const tagCounts: Record<string, number> = {};
  let tokens = 0; let reportedCost = 0; let unpricedTokens = 0;
  for (const r of all.values()) {
    counts[r.status] += 1;
    if (r.tag && (r.status === "tagged" || r.status === "review")) tagCounts[r.tag] = (tagCounts[r.tag] ?? 0) + 1;
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
    if (!file) return null;
    const wire = file.mode === "companies" ? (tags?.tags.length ? toTagWire(tags) : null) : set?.questions.length ? toWireQuestions(set.questions) : null;
    if (!wire) return null;
    const questionTokens = estimateTokens(wire);
    let sum = 0;
    file.profiles.forEach((p, i) => { if (!file.duplicates.has(i)) sum += estimateTokens(p) + questionTokens; });
    return { tokens: sum, cost: sum * PRICE_PER_TOKEN, perRow: toCheck ? Math.round(sum / toCheck) : 0 };
  }, [file, set, tags, toCheck]);

  const gaps = useMemo(() => (file && file.mode === "contacts" && set?.questions.length ? (missingFields(set.questions, file.profiles) as Record<string, string[]>) : {}), [file, set]);
  const columnStats = useMemo(() => (file ? (planSummary(file.plan) as { used: number; identity: number; ignored: number }) : null), [file]);

  const visible: number[] = (() => {
    if (!file) return [];
    if (filter === "all") {
      if (!done) return file.rows.slice(0, VISIBLE_ROWS).map((_, i) => i);
      // Newest verdicts on top so the table visibly fills as answers land; the rows still in flight sit
      // underneath rather than pinning four dozen "Checking…" rows above every result. Walked from the end
      // and stopped at the cap, because this runs every frame and a 100k-row run must not copy the lot.
      const out: number[] = [];
      for (let k = order.current.length - 1; k >= 0 && out.length < VISIBLE_ROWS; k -= 1) out.push(order.current[k]);
      for (const i of stages.current.keys()) { if (out.length >= VISIBLE_ROWS) break; if (!all.has(i)) out.push(i); }
      for (const i of file.duplicates) { if (out.length >= VISIBLE_ROWS) break; out.push(i); }
      return out;
    }
    const tagKey = filter.startsWith("tag:") ? filter.slice(4) : "";
    const out: number[] = [];
    for (const [i, r] of all) { if (tagKey ? r.tag === tagKey && r.status !== "error" : r.status === filter) { out.push(i); if (out.length >= VISIBLE_ROWS) break; } }
    return out.sort((a, b) => a - b);
  })();
  const filteredCount = filter === "all" ? total : filter.startsWith("tag:") ? tagCounts[filter.slice(4)] ?? 0 : counts[filter as Status] ?? 0;

  /** What enrichment found, as columns beside the verdict — the scraped facts are worth keeping in the sheet. */
  const enrichCells = (m: Mode, i: number): string[] => {
    const e = enrichedRef.current.get(i);
    return ENRICH_COLUMNS[m].map(([key]) => {
      if (!e) return "";
      if (key === "source") return e.source.url;
      if (key === "evidence") return e.evidence.map((q) => q.quote).join(" | ");
      const v = e.structured?.[key];
      if (Array.isArray(v)) return v.map((x) => [x?.title, x?.company].filter(Boolean).join(" @ ")).join("; ");
      return typeof v === "string" ? v : "";
    });
  };

  const exportCompanies = (keep: (r: Result | undefined) => boolean, label: string) => {
    if (!file) return;
    const headers = ["Jev tag", "Jev confidence", "Jev runner-up", "Jev needs review", "Jev note", "Claude review", "Claude new tag", ...ENRICH_COLUMNS.companies.map(([, h]) => h), ...file.headers];
    const rows = file.rows.flatMap((cells, i) => {
      const r = all.get(i);
      if (!keep(r)) return [];
      const tagged = r && (r.status === "tagged" || r.status === "review");
      const lead = [tagged ? r.label ?? "" : r ? STATUS_LABEL[r.status] : "Not checked", tagged && !r?.review ? pct(r.confidence) : r?.review ? r.review.confidence : "", r?.runnerUp ? `${r.runnerUp.label} (${pct(r.runnerUp.p)})` : "", r?.status === "review" ? "Yes" : "", r?.note ?? "",
        r?.review ? `${r.review.reason}${r.review.jevLabel ? ` (Jev said ${r.review.jevLabel})` : ""}` : "", r?.review?.kind === "new" && !tags?.tags.some((t) => t.key === r.tag) ? "Yes" : ""];
      return [[...lead, ...enrichCells("companies", i), ...cells]];
    });
    download(`${slug}-jev-${label}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
  };

  const exportRows = (keep: (r: Result | undefined) => boolean, label: string) => {
    if (!file || !set) return;
    const headers = ["Jev verdict", "Jev fit score", "Jev reason", "Jev note", ...set.questions.map((q) => `Jev: ${q.label}`), ...ENRICH_COLUMNS.contacts.map(([, h]) => h), ...file.headers];
    const rows = file.rows.flatMap((cells, i) => {
      const r = all.get(i);
      if (!keep(r)) return [];
      const verdict = [r ? STATUS_LABEL[r.status] : "Not checked", typeof r?.score === "number" ? pct(r.score) : "", r?.reason ?? "", r?.note ?? "", ...set.questions.map((q) => (r?.scores ? pct(r.scores[q.key]) : ""))];
      return [[...verdict, ...enrichCells("contacts", i), ...cells]];
    });
    const stamp = new Date().toISOString().slice(0, 10);
    download(`${slug}-jev-${label}-${stamp}.csv`, toCsv(headers, rows));
  };

  const configured = mode === "companies" ? Boolean(tags?.tags.length) : Boolean(set?.questions.length);
  const ready = Boolean(!stale && jev?.configured && configured && file && file.mode === mode && !editing && !editingTags);
  const tagLabel = (key: string) => tags?.tags.find((t) => t.key === key)?.label ?? newTagLabels.current.get(key) ?? key;
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

              {stale && (
                <div className="jev-banner is-error">Reply Radar was updated since this page opened. <button className="secondary-button" onClick={() => window.location.reload()}>Reload</button></div>
              )}
              {jev && !jev.configured && (
                <div className="jev-banner is-error">OPENROUTER_API_KEY is not set on this deployment. Add it in Vercel → Settings → Environment Variables, then redeploy.</div>
              )}

              <div className="jev-modes" role="tablist" aria-label="List type">
                {(["contacts", "companies"] as Mode[]).map((m) => (
                  <button key={m} role="tab" aria-selected={mode === m} className={`jev-mode ${mode === m ? "on" : ""}`} onClick={() => setMode(m)} disabled={running}>
                    {m === "contacts" ? "Contact lists" : "Company lists"}
                    <small>{m === "contacts" ? (set?.questions.length ? `${set.questions.length} questions` : "not set up") : (tags?.tags.length ? `${tags.tags.length} tags` : "not set up")}</small>
                  </button>
                ))}
              </div>

              <div className="jev-grid">
                {mode === "contacts" ? (
                  /* ── Screening questions ── */
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
                    {!editing && !collapsed && (
                      <IcpBox
                        key={`contacts-${set?.updatedAt ?? ""}`}
                        icp={set?.icp}
                        brief={set?.brief ?? ""}
                        busy={busy === "building"}
                        disabled={running || (Boolean(busy) && busy !== "building")}
                        onBuild={(t, icp) => void buildSetup(t, icp)}
                      />
                    )}
                    {notice && <div className={`jev-banner is-${notice.kind}`}>{notice.text}</div>}
                    {editing ? (
                      <QuestionEditor value={editing} onChange={setEditing} />
                    ) : set?.questions.length && collapsed ? (
                      <div className="jev-q-chips">{set.questions.map((q, n) => <span key={q.key}><b>{n + 1}</b>{q.label}</span>)}</div>
                    ) : set?.questions.length ? (
                      <>
                        <QuestionList set={set} missing={gaps} />
                        <div className="jev-rule-line">
                          Good fit: average ≥ {Math.round(set.thresholds.keep * 100)}% · Dropped: a must-have &lt; {Math.round(set.thresholds.drop * 100)}%, an exclusion ≥ 80% sure{set.icp && (set.icp.sizeMin || set.icp.sizeMax) ? `, or outside ${set.icp.sizeMin ?? 0}–${set.icp.sizeMax ?? "any"} employees` : ""}{" · "}can&apos;t-tell answers don&apos;t count
                          {set.updatedAt && <span> · saved {new Date(set.updatedAt).toLocaleString()}</span>}
                        </div>
                      </>
                    ) : null}
                  </section>
                ) : (
                  /* ── Company tags ── */
                  <section className="jev-panel">
                    <div className="jev-panel-head">
                      <h2>Company tags {tags?.tags.length ? <span className="jev-badge">{tags.tags.length}</span> : null}</h2>
                      <div className="jev-actions">
                        {!editingTags && !running && retag.length > 0 && <button className="primary-button" onClick={() => { const rows = retag; setRetag([]); void run(rows); }}>Re-tag {retag.length.toLocaleString()}</button>}
                        {!editingTags && !running && !suggestion && (tagCounts.other ?? 0) >= 3 && file?.mode === "companies" && <button className="secondary-button" onClick={() => void suggestFromOther()} disabled={Boolean(busy)}>{busy === "building" ? "Suggesting…" : `Suggest tags from Other (${(tagCounts.other ?? 0).toLocaleString()})`}</button>}
                        {!editingTags && Boolean(tags?.tags.length) && <button className="secondary-button" onClick={() => setCollapsed((c) => !c)}>{collapsed ? "Show" : "Hide"}</button>}
                        {!editingTags && <button className="secondary-button" onClick={() => { setCollapsed(false); setEditingTags(tags ? structuredClone(tags) : { instructions: "Which category best describes what this organization primarily is?", tags: [{ key: "", label: "", description: "" }], minConfidence: 0.6 }); }} disabled={Boolean(busy) || running}>{tags?.tags.length ? "Edit" : "Write by hand"}</button>}
                        {editingTags && <button className="secondary-button" onClick={() => setEditingTags(null)} disabled={busy === "saving"}>Cancel</button>}
                        {editingTags && <button className="primary-button" onClick={() => void saveTags()} disabled={busy === "saving"}>{busy === "saving" ? "Saving…" : "Save tags"}</button>}
                      </div>
                    </div>
                    {!editingTags && !collapsed && (
                      <DescribeBox
                        key={`companies-${tags?.updatedAt ?? ""}`}
                        label="Describe how to tag the companies"
                        value={tags?.brief ?? ""}
                        placeholder="e.g. Tag each company as one of: Health System | Community Hospital | Academic Medical Center | Behavioral Health Provider | Health Technology / Digital Health | Other"
                        busy={busy === "building"}
                        disabled={running || (Boolean(busy) && busy !== "building")}
                        onBuild={(t) => void buildSetup(t)}
                      />
                    )}
                    {notice && <div className={`jev-banner is-${notice.kind}`}>{notice.text}</div>}
                    {proposals && proposals.length > 0 && !editingTags && <SuggestPanel title="New tags Claude proposed" suggestions={proposals} outOfScope={[]} busy={busy === "saving"} onAdd={(c) => void adoptProposals(c)} onDismiss={() => setProposals(null)} />}
                    {suggestion && !editingTags && <SuggestPanel suggestions={suggestion.suggestions} outOfScope={suggestion.outOfScope} busy={busy === "saving"} onAdd={(c) => void addSuggested(c)} onDismiss={() => setSuggestion(null)} />}
                    {editingTags ? <TagEditor value={editingTags} onChange={setEditingTags} /> : tags?.tags.length ? <TagList set={tags} collapsed={collapsed} counts={tagCounts} /> : null}
                  </section>
                )}

                {/* ── The list ── */}
                <section className="jev-panel">
                  <div className="jev-panel-head">
                    <h2>{mode === "companies" ? "Company list" : "Contact list"}</h2>
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
                        <span><b>{total.toLocaleString()}</b> {mode === "companies" ? "companies" : "contacts"}</span>
                        {file.duplicates.size > 0 && <span><b>{file.duplicates.size}</b> duplicates skipped</span>}
                        <span><b>{columnStats?.used}</b> of {file.headers.length} columns used</span>
                        {estimate && <span><b>~{estimate.perRow}</b> tokens / row</span>}
                        {estimate && <span>est. <b>{money(estimate.cost)}</b></span>}
                      </div>
                      <details className="jev-peek">
                        <summary>What Jev sees for row 1</summary>
                        <pre>{JSON.stringify(file.profiles[0], null, 2)}</pre>
                      </details>
                      <ColumnPanel file={file} onChange={setColumnRole} disabled={running} />
                    </div>
                  )}
                  {fileError && <div className="jev-banner is-error">{fileError}</div>}
                  {file && (
                    <EnrichControl mode={mode} value={enrichMode} onChange={setEnrichMode} detection={detection} disabled={running} llmModel={enrichCfg?.structureModel ?? "openai/gpt-6-luna"} />
                  )}
                  <div className="jev-run-row">
                    {!running ? (
                      <button className="primary-button jev-run" onClick={() => void run()} disabled={!ready}>{done > counts.duplicate ? "Run again" : "Run"}</button>
                    ) : (
                      <button className="secondary-button jev-run" onClick={stop}>Stop</button>
                    )}
                    {!running && errors.length > 0 && <button className="secondary-button" onClick={() => void run(errors)}>Retry {errors.length} failed</button>}
                    {!ready && !running && (
                      <span className="jev-hint">
                        {!jev?.configured ? "Connect Jev first." : !configured ? (mode === "companies" ? "Set up the tags first." : "Add questions first.") : editing || editingTags ? "Save or cancel the edit first." : !file ? "Upload a CSV." : ""}
                      </span>
                    )}
                  </div>
                </section>
              </div>

              {/* ── Progress ── */}
              {file && (done > counts.duplicate || running) && (
                <section className="jev-progress" ref={progressRef}>
                  <div className="jev-progress-top">
                    <strong>{running ? (file.mode === "companies" ? "Tagging…" : "Checking…") : finished ? "Done" : "Stopped"}</strong>
                    {(stats.current.structure.cost > 0 || stats.current.scrape.cost > 0) && <span>enrichment {money(stats.current.structure.cost + stats.current.scrape.cost)}</span>}
                    <span className="jev-progress-count">{done.toLocaleString()} / {total.toLocaleString()}</span>
                    <span>{fmtDuration(elapsed)}{running && remaining > 0 ? ` · ~${fmtDuration(remaining)} left` : ""}</span>
                    {rate > 0 && <span>{rate.toFixed(1)} / sec</span>}
                    <span>Jev {tokens.toLocaleString()} tokens · {money(spent)}</span>
                  </div>
                  <div className="jev-bar" aria-label={`${Math.round(progress * 100)}% checked`}>
                    <i className="good" style={{ width: `${((counts.good + counts.tagged) / total) * 100}%` }} />
                    <i className="borderline" style={{ width: `${((counts.borderline + counts.review) / total) * 100}%` }} />
                    <i className="bad" style={{ width: `${(counts.bad / total) * 100}%` }} />
                    <i className="duplicate" style={{ width: `${(counts.duplicate / total) * 100}%` }} />
                    <i className="error" style={{ width: `${(counts.error / total) * 100}%` }} />
                  </div>
                  <StageCards stats={stats.current} mode={file.mode} running={running} rows={file.rows.length} llmModel={enrichCfg?.structureModel ?? "openai/gpt-6-luna"} enrichMode={enrichMode} />
                  {runError && <div className="jev-banner is-error">{runError}</div>}
                  {finished && file.mode === "contacts" && (
                    <div className="jev-downloads">
                      <button className="primary-button" onClick={() => exportRows((r) => r?.status === "good", "good-fits")} disabled={!counts.good}>Download {counts.good.toLocaleString()} good fits</button>
                      <button className="secondary-button" onClick={() => exportRows((r) => r?.status === "borderline", "borderline")} disabled={!counts.borderline}>Borderline ({counts.borderline.toLocaleString()})</button>
                      <button className="secondary-button" onClick={() => exportRows((r) => r?.status === "bad" || r?.status === "duplicate", "removed")} disabled={!counts.bad && !counts.duplicate}>Removed ({(counts.bad + counts.duplicate).toLocaleString()})</button>
                      <button className="secondary-button" onClick={() => exportRows(() => true, "all")}>Everything, with verdicts</button>
                    </div>
                  )}
                  {finished && file.mode === "companies" && (
                    <div className="jev-downloads">
                      <button className="primary-button" onClick={() => exportCompanies(() => true, "tagged")}>Download all {total.toLocaleString()}, tagged</button>
                      {filter.startsWith("tag:") && <button className="secondary-button" onClick={() => exportCompanies((r) => r?.tag === filter.slice(4) && r?.status !== "error", `tag-${filter.slice(4)}`)}>Only {tagLabel(filter.slice(4))} ({(tagCounts[filter.slice(4)] ?? 0).toLocaleString()})</button>}
                      <button className="secondary-button" onClick={() => exportCompanies((r) => r?.status === "review", "needs-review")} disabled={!counts.review}>Needs review ({counts.review.toLocaleString()})</button>
                      {(() => {
                        const n = [...all.values()].filter((r) => (r.status === "review" || (r.status === "tagged" && r.tag === "other")) && !r.review).length;
                        if (review) return <button className="secondary-button" disabled>Claude reviewing… {review.done}/{review.total}</button>;
                        return n > 0 ? <button className="primary-button" onClick={() => void reviewWithClaude()}>Review {n.toLocaleString()} with Claude</button> : null;
                      })()}
                    </div>
                  )}
                  <ActivityLog lines={logLines.current} />
                </section>
              )}

              {/* ── Rows ── */}
              {file && (
                <section className="jev-table-wrap">
                  <div className="jev-filters">
                    {(file.mode === "companies" ? ["all", "review", "duplicate", "error"] : ["all", "good", "borderline", "bad", "duplicate", "error"]).map((f) => (
                      (f === "all" || counts[f as Status] > 0) && (
                        <button key={f} className={`jev-filter ${f === "review" ? "borderline" : f} ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
                          {f === "all" ? "All" : STATUS_LABEL[f as Status]} <b>{(f === "all" ? total : counts[f as Status]).toLocaleString()}</b>
                        </button>
                      )
                    ))}
                    {file.mode === "companies" && Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                      <button key={k} className={`jev-filter tag ${filter === `tag:${k}` ? "on" : ""}`} onClick={() => setFilter(`tag:${k}`)}>{tagLabel(k)} <b>{n.toLocaleString()}</b></button>
                    ))}
                    {filteredCount > VISIBLE_ROWS && <span className="jev-hint">Showing {filter === "all" && done ? "the latest" : "the first"} {VISIBLE_ROWS} of {filteredCount.toLocaleString()} — downloads include every row.</span>}
                  </div>
                  <div className="jev-table">
                    <div className={`jev-tr jev-th ${file.mode === "companies" ? "is-co" : ""}`}>
                      {file.mode === "companies"
                        ? <><span>#</span><span>Company</span><span>Website</span><span>Tag</span><span>Confidence · runner-up</span></>
                        : <><span>#</span><span>Contact</span><span>Company</span><span>Verdict</span><span>Why</span></>}
                    </div>
                    {visible.map((i) => {
                      const p = file.people[i];
                      const r = all.get(i);
                      const inStage = !r ? stages.current.get(i) : undefined;
                      const status = r?.status ?? (inStage ? "checking" : "pending");
                      const open = expanded === i;
                      const co = file.mode === "companies";
                      const tagged = co && (status === "tagged" || status === "review");
                      return (
                        <div key={i} className={`jev-row ${open ? "open" : ""}`}>
                          <div className={`jev-tr is-${status} ${co ? "is-co" : ""}`} role="button" tabIndex={0} onClick={() => setExpanded(open ? null : i)} onKeyDown={(e) => { if (e.key === "Enter") setExpanded(open ? null : i); }}>
                            <span className="jev-idx">{i + 1}</span>
                            <span className="jev-person">
                              <i>{initials(p.name)}</i>
                              <span><strong>{p.name}</strong><small>{p.title}</small></span>
                            </span>
                            <span className="jev-company">{p.company}</span>
                            <span>
                              <em className={`jev-verdict ${status === "tagged" ? "good" : status === "review" ? "borderline" : status}`}>
                                {status === "checking" ? (inStage ? STAGE_LABEL[inStage] : "Checking…") : status === "pending" ? "Waiting" : tagged ? r?.label : STATUS_LABEL[status as Status]}
                              </em>
                            </span>
                            <span className="jev-why">
                              {r?.review && r.review.kind !== "unplaced" && <span className="jev-claude-tag" title={r.review.jevLabel ? `Jev said: ${r.review.jevLabel}` : ""}>claude{r.review.kind === "new" && !tags?.tags.some((t) => t.key === r.tag) ? " · new tag" : ""}</span>}
                              {r?.enriched && <span className="jev-enriched-tag" title={r.firstStatus ? `Before enrichment: ${r.firstStatus}` : "Judged on scraped data"}>enriched</span>}
                              {/* A row Claude placed shows Claude's confidence, not the Jev score it overruled. */}
                              {r?.review && r.review.kind !== "unplaced" ? <>{r.review.confidence} confidence{r.review.jevLabel && r.review.jevLabel !== r.label ? <span className="jev-runner"> · Jev said {r.review.jevLabel}</span> : null}</>
                                : tagged ? <>{pct(r?.confidence)}{r?.runnerUp ? <span className="jev-runner"> · or {r.runnerUp.label} {pct(r.runnerUp.p)}</span> : null}{status === "review" ? <span className="jev-review"> · needs review</span> : null}</> : r?.reason}
                              {r?.review && <span className="jev-note">Claude ({r.review.confidence}): {r.review.reason}</span>}
                              {r?.note && <span className="jev-note">{r.note}</span>}
                            </span>
                          </div>
                          {open && (
                            <div className="jev-detail">
                              {r?.scores && set && !co && (
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
                              {co && r?.top && (
                                <div className="jev-scores">
                                  {r.top.filter((t) => t.p > 0).map((t, n) => (
                                    <div key={t.tag} className="jev-score">
                                      <span>{t.label}</span>
                                      <div className="jev-score-track"><i className={n === 0 ? (status === "review" ? "borderline" : "good") : "none"} style={{ width: `${t.p * 100}%` }} /></div>
                                      <b>{pct(t.p)}</b>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {enrichedRef.current.get(i) && (() => {
                                const e = enrichedRef.current.get(i)!;
                                return (
                                  <div className="jev-enrich-detail">
                                    <div className="jev-enrich-src">
                                      Enriched from {e.source.kind === "aiark" ? "AI Ark · " : ""}<a href={e.source.url} target="_blank" rel="noreferrer">{e.source.url.replace(/^https:\/\/(www\.)?/, "")}</a>
                                      {e.source.chars ? ` · ${e.source.chars.toLocaleString()} chars` : ""}{e.source.pages && e.source.pages.length > 1 ? " · home + about" : ""}
                                      {r?.firstStatus && <> · before: <b>{r.firstStatus}</b></>}
                                      {e.filled.length > 0 && <> · added {e.filled.join(", ")}</>}
                                    </div>
                                    {e.evidence.length > 0 && <ul className="jev-evidence">{e.evidence.map((q, k) => <li key={k}>{q.field && <b>{q.field}</b>}“{q.quote}”</li>)}</ul>}
                                  </div>
                                );
                              })()}
                              {p.linkedin && <a href={/^https?:/i.test(p.linkedin) ? p.linkedin : `https://${p.linkedin}`} target="_blank" rel="noreferrer" className="jev-li">{co ? "Open ↗" : "LinkedIn ↗"}</a>}
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
