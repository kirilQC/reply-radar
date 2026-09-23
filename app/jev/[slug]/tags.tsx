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
