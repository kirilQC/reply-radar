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

export function IcpBox({ icp, brief, busy, disabled, onBuild }: {
  icp?: Icp | null; brief: string; busy: boolean; disabled: boolean;
  onBuild: (description: string, icp: Record<string, unknown>) => void;
}) {
  // Seeded from what is saved; the parent re-keys this box after a build so it picks up the new values.
  const [titles, setTitles] = useState((icp?.titles ?? []).join("\n"));
  const [responsibilities, setResponsibilities] = useState(icp?.responsibilities ?? "");
  const [sizeMin, setSizeMin] = useState(icp?.sizeMin ? String(icp.sizeMin) : "");
  const [sizeMax, setSizeMax] = useState(icp?.sizeMax ? String(icp.sizeMax) : "");
  const [exclusions, setExclusions] = useState(icp?.exclusions ?? "");
  const [notes, setNotes] = useState(brief);
  const count = titles.split("\n").map((t) => t.trim()).filter(Boolean).length;
  const empty = !count && !responsibilities.trim() && !sizeMin && !sizeMax && !exclusions.trim() && !notes.trim();
  return (
    <div className="jev-describe jev-icp">
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
