// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/purity -- the Bright Data wait shows seconds elapsed, read from the clock on each repaint */

/**
 * What the pipeline is doing, drawn: one card per stage with its live counts and cost, and an activity log of
 * every read, batch and failure. The counts come straight from the pipeline's stats object, so a card can never
 * claim progress the run has not made.
 */
import { BRIGHTDATA_PER_RECORD, type EnrichMode, type Mode, type PipelineStats, type Stage } from "./pipeline";

export type LogLine = { t: number; kind: "info" | "ok" | "warn" | "error"; text: string };
export type Detection = { rows: number; thin: number; scrapeable: number; noTarget: number; blocked: boolean };

const money = (n: number) => (n <= 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const n = (x: number) => x.toLocaleString();

/** Enrichment choice plus what detection found in this file, before anything is spent. */
export function EnrichControl({ mode, value, onChange, detection, disabled, llmModel }: {
  mode: Mode; value: EnrichMode; onChange: (v: EnrichMode) => void; detection: Detection | null; disabled: boolean; llmModel: string; brightData?: boolean;
}) {
  const source = mode === "companies" ? "company websites" : "LinkedIn profiles (Bright Data)";
  const scrapeCost = mode === "contacts" && detection ? detection.scrapeable * BRIGHTDATA_PER_RECORD : 0;
  return (
    <div className="jev-enrich">
      <div className="jev-enrich-head">
        <span className="jev-enrich-title">Enrichment</span>
        <div className="jev-seg">
          {(["auto", "all", "off"] as EnrichMode[]).map((m) => (
            <button key={m} type="button" className={value === m ? "on" : ""} onClick={() => onChange(m)} disabled={disabled}>{m === "auto" ? "Auto" : m === "all" ? "Every row" : "Off"}</button>
          ))}
        </div>
      </div>
      {detection && value !== "off" && (
        <div className="jev-enrich-body">
          <span><b>{n(detection.thin)}</b> of {n(detection.rows)} rows have thin data</span>
          <span><b>{n(value === "all" ? detection.rows - detection.noTarget : detection.scrapeable)}</b> {value === "all" ? "would be scraped" : "can be scraped"} from {source}</span>
          {detection.noTarget > 0 && <span><b>{n(detection.noTarget)}</b> have no {mode === "companies" ? "website" : "LinkedIn URL"}</span>}
          <span>structured by <b>{llmModel.replace(/^openai\//, "")}</b></span>
          {mode === "contacts" && <span>scrape ≈ <b>{money(scrapeCost)}</b> at most</span>}
          {detection.blocked && <span className="jev-warn-line">LinkedIn scraping is not set up — add BRIGHTDATA_API_KEY in Vercel. Contacts will be judged on the CSV alone.</span>}
        </div>
      )}
    </div>
  );
}

const STAGES: [Stage | "read", string][] = [["read", "Read list"], ["first", "Jev first pass"], ["scrape", "Scrape"], ["structure", "Structure"], ["final", "Jev final pass"]];

/** One card per stage. A stage is lit while it has work in flight or queued, and checked once it has none left. */
export function StageCards({ stats, mode, running, rows, llmModel, enrichMode }: { stats: PipelineStats; mode: Mode; running: boolean; rows: number; llmModel: string; enrichMode: EnrichMode }) {
  return (
    <div className="jev-stages">
      {STAGES.map(([key, label], idx) => {
        if (key === "read") {
          return (
            <div key={key} className="jev-stage is-done">
              <div className="jev-stage-top"><span className="jev-stage-n">{idx + 1}</span><strong>{label}</strong></div>
              <div className="jev-stage-main">{n(rows)}</div>
              <div className="jev-stage-sub">rows, columns mapped</div>
            </div>
          );
        }
        const s = stats[key];
        const skipped = (key === "first" && enrichMode === "all") || (key !== "first" && enrichMode === "off");
        const busy = s.active > 0 || s.queued > 0;
        const state = skipped ? "is-skipped" : busy ? "is-active" : s.done + s.failed > 0 ? "is-done" : running ? "is-waiting" : "";
        const sub =
          key === "scrape" ? (mode === "companies" ? "websites read" : "LinkedIn profiles") :
          key === "structure" ? llmModel.replace(/^openai\//, "") :
          key === "first" ? "on the CSV data" : "on enriched data";
        const cost = key === "structure" ? s.cost : key === "scrape" ? s.cost : 0;
        return (
          <div key={key} className={`jev-stage ${state}`}>
            <div className="jev-stage-top"><span className="jev-stage-n">{idx + 1}</span><strong>{label}</strong>{busy && <i className="jev-stage-pulse" />}</div>
            <div className="jev-stage-main">{skipped ? "—" : n(s.done)}</div>
            <div className="jev-stage-sub">{skipped ? "skipped" : sub}</div>
            {!skipped && (
              <div className="jev-stage-meta">
                {s.active > 0 && <span className="active">{n(s.active)} in progress</span>}
                {s.queued > 0 && <span>{n(s.queued)} queued</span>}
                {s.failed > 0 && <span className="failed">{n(s.failed)} failed</span>}
                {key === "scrape" && s.skipped > 0 && <span>{n(s.skipped)} not needed</span>}
                {cost > 0 && <span>{key === "scrape" ? "≈" : ""}{money(cost)}</span>}
              </div>
            )}
            {key === "structure" && s.waitUntil && s.waitUntil > Date.now() && <div className="jev-stage-job">Rate limited by OpenRouter · resuming in {Math.ceil((s.waitUntil - Date.now()) / 1000)}s</div>}
            {key === "scrape" && stats.job && <div className="jev-stage-job">Waiting on Bright Data · {n(stats.job.count)} profiles · {Math.round((Date.now() - stats.job.since) / 1000)}s</div>}
          </div>
        );
      })}
    </div>
  );
}

export function ActivityLog({ lines }: { lines: LogLine[] }) {
  if (!lines.length) return null;
  const shown = lines.slice(-200).reverse();
  return (
    <details className="jev-log" open>
      <summary>Activity <b>{n(lines.length)}</b></summary>
      <ol>
        {shown.map((l, k) => (
          <li key={`${l.t}-${k}`} className={`is-${l.kind}`}>
            <time>{new Date(l.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
