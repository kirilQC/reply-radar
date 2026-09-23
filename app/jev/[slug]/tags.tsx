// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * The pieces of the Jev page that are specific to company tagging, plus the plain-language box both modes share.
 * Kept apart from the page so the page stays about the run itself.
 */
import { useState } from "react";

export type Tag = { key: string; label: string; description: string };
export type TagSet = { instructions: string; tags: Tag[]; minConfidence: number; source?: string; updatedAt?: string; brief?: string };

/**
 * The box a non-technical teammate types into. What they write is sent to the build route, which turns it into
 * the Jev setup and saves it; the result is shown for review before anything runs.
 */
export function DescribeBox({ value, placeholder, busy, disabled, onBuild, label }: {
  value: string; placeholder: string; busy: boolean; disabled: boolean; label: string;
  onBuild: (text: string) => void;
}) {
  // Seeded from the saved description; the parent re-keys this box on a rebuild so it picks up the new text
  // without an effect copying props into state.
  const [text, setText] = useState(value);
  return (
    <div className="jev-describe">
      <label className="jev-describe-label" htmlFor="jev-describe">{label}</label>
      <textarea id="jev-describe" className="jev-input jev-textarea jev-describe-text" rows={4} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} disabled={disabled} />
      <div className="jev-describe-foot">
        <button className="primary-button" onClick={() => onBuild(text)} disabled={disabled || busy || !text.trim()}>{busy ? "Building…" : "Build Jev setup"}</button>
      </div>
    </div>
  );
}

export function TagList({ set, collapsed, counts }: { set: TagSet; collapsed: boolean; counts?: Record<string, number> }) {
  if (collapsed) {
    return <div className="jev-q-chips">{set.tags.map((t) => <span key={t.key}>{t.label}{counts?.[t.key] ? <b className="jev-chip-count">{counts[t.key].toLocaleString()}</b> : null}</span>)}</div>;
  }
  return (
    <>
      <ol className="jev-taglist">
        {set.tags.map((t) => (
          <li key={t.key}>
            <strong>{t.label}</strong>
            {t.description ? <span>{t.description}</span> : <span className="jev-muted">No description — Jev has only the name to go on.</span>}
          </li>
        ))}
      </ol>
      <div className="jev-rule-line">
        One tag per company · below {Math.round(set.minConfidence * 100)}% confidence it goes to Needs review
        {set.updatedAt && <span> · saved {new Date(set.updatedAt).toLocaleString()}</span>}
      </div>
    </>
  );
}

export function TagEditor({ value, onChange }: { value: TagSet; onChange: (v: TagSet) => void }) {
  const setTag = (idx: number, patch: Partial<Tag>) => onChange({ ...value, tags: value.tags.map((t, i) => (i === idx ? { ...t, ...patch } : t)) });
  return (
    <div className="jev-editor">
      <label className="jev-stack">
        <span>Question Jev answers</span>
        <input className="jev-input" value={value.instructions} onChange={(e) => onChange({ ...value, instructions: e.target.value })} />
      </label>
      {value.tags.map((t, idx) => (
        <div className="jev-tag-edit" key={idx}>
          <input className="jev-input jev-tag-label" value={t.label} placeholder="Tag" onChange={(e) => setTag(idx, { label: e.target.value })} />
          <textarea className="jev-input jev-textarea" rows={2} value={t.description} placeholder="What belongs in this tag, and how it differs from its neighbours" onChange={(e) => setTag(idx, { description: e.target.value })} />
          <button type="button" className="jev-icon-btn danger" title="Remove tag" onClick={() => onChange({ ...value, tags: value.tags.filter((_, i) => i !== idx) })}>✕</button>
        </div>
      ))}
      <div className="jev-edit-foot">
        <button type="button" className="jev-link-btn" onClick={() => onChange({ ...value, tags: [...value.tags, { key: "", label: "", description: "" }] })}>+ Tag</button>
        <div className="jev-thresholds">
          <label><span>Needs review below</span><input className="jev-input" type="number" min={1} max={99} value={Math.round(value.minConfidence * 100)} onChange={(e) => onChange({ ...value, minConfidence: Number(e.target.value) / 100 })} />%</label>
        </div>
      </div>
    </div>
  );
}

export type Suggestion = { label: string; description: string; examples: string[]; count: number };

/**
 * New tags proposed from a run's "Other" pile: tick the ones to keep, rename if needed, add. Nothing is saved
 * until "Add" — a suggestion is a proposal about the client's market, and the team owns that call.
 */
export function SuggestPanel({ suggestions, outOfScope, busy, onAdd, onDismiss }: {
  suggestions: Suggestion[]; outOfScope: string[]; busy: boolean;
  onAdd: (chosen: Suggestion[]) => void; onDismiss: () => void;
}) {
  const [picked, setPicked] = useState(() => suggestions.map(() => true));
  const [labels, setLabels] = useState(() => suggestions.map((s) => s.label));
  const chosen = suggestions.map((s, k) => ({ ...s, label: labels[k].trim() })).filter((s, k) => picked[k] && s.label);
  return (
    <div className="jev-suggest">
      <div className="jev-suggest-head">
        <strong>Suggested tags <b>{suggestions.length}</b></strong>
        <div className="jev-actions">
          <button className="secondary-button" onClick={onDismiss} disabled={busy}>Dismiss</button>
          <button className="primary-button" onClick={() => onAdd(chosen)} disabled={busy || !chosen.length}>{busy ? "Adding…" : `Add ${chosen.length} tag${chosen.length === 1 ? "" : "s"}`}</button>
        </div>
      </div>
      {suggestions.length === 0 && <div className="jev-empty small">No new tag would group these — they look genuinely outside the market.</div>}
      <ol className="jev-suggest-list">
        {suggestions.map((s, k) => (
          <li key={k} className={picked[k] ? "on" : ""}>
            <input className="jev-suggest-pick" type="checkbox" aria-label={`Add ${labels[k] || "this tag"}`} checked={picked[k]} onChange={(e) => setPicked((p) => p.map((v, j) => (j === k ? e.target.checked : v)))} />
            <div className="jev-suggest-body">
              <div className="jev-suggest-top">
                <input className="jev-input jev-tag-label" value={labels[k]} onChange={(e) => setLabels((l) => l.map((v, j) => (j === k ? e.target.value : v)))} aria-label="Tag name" />
                {s.count > 0 && <span className="jev-suggest-count">~{s.count}</span>}
              </div>
              {s.description && <p>{s.description}</p>}
              {s.examples.length > 0 && <div className="jev-suggest-ex">{s.examples.join(" · ")}</div>}
            </div>
          </li>
        ))}
      </ol>
      {outOfScope.length > 0 && <div className="jev-suggest-out">Staying in Other ({outOfScope.length}): {outOfScope.slice(0, 12).join(" · ")}{outOfScope.length > 12 ? " …" : ""}</div>}
    </div>
  );
}
