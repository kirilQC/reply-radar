// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * The contact-list ICP, as a form rather than a paragraph: the pool of target titles, what those people are
 * responsible for, the company size range, and exclusions — plus free text for anything else.
 *
 * ── Why structured ───────────────────────────────────────────────────────────────────────────────
 * A paragraph handed to the question writer produced six strict questions and a 4% pass rate on a list the team
 * had already vetted. The pool of titles is the team's own definition of who they sell to, so it becomes one Jev
 * question verbatim; the size range is checked in code; only responsibilities and exclusions are left for the
 * model to phrase.
 */
import { useState } from "react";

export type Icp = { titles: string[]; responsibilities: string; sizeMin: number | null; sizeMax: number | null; exclusions: string };

export function IcpBox({ icp, brief, busy, disabled, onBuild, json, onImport }: {
  icp?: Icp | null; brief: string; busy: boolean; disabled: boolean;
  onBuild: (description: string, icp: Record<string, unknown>) => void;
  /** The saved setup as editable JSON, and the save for it — the no-AI way in. Absent for company tags. */
  json?: string; onImport?: (text: string) => void;
}) {
  // Seeded from what is saved; the parent re-keys this box after a build so it picks up the new values.
  const [titles, setTitles] = useState((icp?.titles ?? []).join("\n"));
  const [responsibilities, setResponsibilities] = useState(icp?.responsibilities ?? "");
  const [sizeMin, setSizeMin] = useState(icp?.sizeMin ? String(icp.sizeMin) : "");
  const [sizeMax, setSizeMax] = useState(icp?.sizeMax ? String(icp.sizeMax) : "");
  const [exclusions, setExclusions] = useState(icp?.exclusions ?? "");
  const [notes, setNotes] = useState(brief);
  // Two ways in: a plain prompt, for anyone who would rather describe the list in their own words, or the form.
  // Opens on whichever the saved setup was built from.
  const hasIcp = Boolean(icp && (icp.titles?.length || icp.responsibilities || icp.sizeMin || icp.sizeMax || icp.exclusions));
  const [view, setView] = useState<"prompt" | "form" | "json">(hasIcp ? "form" : "prompt");
  const [jsonText, setJsonText] = useState(json ?? "");
  // Checked as it is typed, so a stray comma is caught here rather than coming back as a failed save.
  const jsonError = (() => { if (!jsonText.trim()) return "Paste a setup."; try { JSON.parse(jsonText); return ""; } catch (e) { return e instanceof Error ? e.message : "Not valid JSON."; } })();
  const count = titles.split("\n").map((t) => t.trim()).filter(Boolean).length;
  const empty = view === "prompt" ? !notes.trim() : !count && !responsibilities.trim() && !sizeMin && !sizeMax && !exclusions.trim() && !notes.trim();
  const tabs = (
    <div className="jev-seg jev-icp-tabs">
      <button type="button" className={view === "prompt" ? "on" : ""} onClick={() => setView("prompt")} disabled={disabled}>Prompt</button>
      <button type="button" className={view === "form" ? "on" : ""} onClick={() => setView("form")} disabled={disabled}>ICP form</button>
      {onImport && <button type="button" className={view === "json" ? "on" : ""} onClick={() => setView("json")} disabled={disabled}>JSON</button>}
    </div>
  );
  if (view === "json" && onImport) {
    return (
      <div className="jev-describe jev-icp">
        <div className="jev-icp-head"><span className="jev-describe-label">Setup as JSON</span>{tabs}</div>
        <textarea className="jev-input jev-textarea jev-describe-text jev-json-text" rows={16} spellCheck={false} value={jsonText} onChange={(e) => setJsonText(e.target.value)} disabled={disabled} />
        <div className="jev-describe-foot">
          {jsonError && jsonText.trim() && <span className="jev-warn-line">{jsonError}</span>}
          <button className="primary-button" disabled={disabled || busy || Boolean(jsonError)} onClick={() => onImport(jsonText)}>{busy ? "Saving…" : "Save JSON setup"}</button>
        </div>
      </div>
    );
  }
  if (view === "prompt") {
    return (
      <div className="jev-describe jev-icp">
        <div className="jev-icp-head"><span className="jev-describe-label">Describe who should stay on the list</span>{tabs}</div>
        <textarea className="jev-input jev-textarea jev-describe-text" rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={disabled} placeholder="e.g. Keep anyone whose role or company involves Medicare, Medicaid or Medicare Advantage in any way…" />
        <div className="jev-describe-foot">
          <button className="primary-button" disabled={disabled || busy || empty} onClick={() => onBuild(notes, {})}>{busy ? "Building…" : "Build Jev setup"}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="jev-describe jev-icp">
      <div className="jev-icp-head"><span className="jev-describe-label">Contact ICP</span>{tabs}</div>
      <div className="jev-icp-grid">
        <label className="jev-icp-titles">
          <span>Target titles <b>{count || ""}</b></span>
          <textarea className="jev-input jev-textarea" rows={7} value={titles} onChange={(e) => setTitles(e.target.value)} disabled={disabled} placeholder={"One per line\nAdministrator\nDirector of Nursing\nOR Director\nPractice Owner"} />
        </label>
        <div className="jev-icp-side">
          <label>
            <span>What they&apos;re responsible for</span>
            <textarea className="jev-input jev-textarea" rows={3} value={responsibilities} onChange={(e) => setResponsibilities(e.target.value)} disabled={disabled} placeholder="e.g. running the surgery center's operations, staffing and purchasing" />
          </label>
          <div className="jev-icp-size">
            <span>Company size</span>
            <input className="jev-input" inputMode="numeric" value={sizeMin} onChange={(e) => setSizeMin(e.target.value.replace(/[^0-9]/g, ""))} disabled={disabled} placeholder="min" aria-label="Minimum employees" />
            <em>–</em>
            <input className="jev-input" inputMode="numeric" value={sizeMax} onChange={(e) => setSizeMax(e.target.value.replace(/[^0-9]/g, ""))} disabled={disabled} placeholder="max" aria-label="Maximum employees" />
            <em>employees</em>
          </div>
          <label>
            <span>Exclude</span>
            <textarea className="jev-input jev-textarea" rows={2} value={exclusions} onChange={(e) => setExclusions(e.target.value)} disabled={disabled} placeholder="e.g. vendors and consultants, ophthalmology-only centers" />
          </label>
        </div>
      </div>
      <label className="jev-icp-notes">
        <span>Anything else</span>
        <textarea className="jev-input jev-textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={disabled} placeholder="Optional" />
      </label>
      <div className="jev-describe-foot">
        <button className="primary-button" disabled={disabled || busy || empty} onClick={() => onBuild(notes, { titles, responsibilities, sizeMin, sizeMax, exclusions })}>{busy ? "Building…" : "Build Jev setup"}</button>
      </div>
    </div>
  );
}
