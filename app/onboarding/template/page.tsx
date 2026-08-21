// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AppSidebar from "../../components/AppSidebar";
import { groupTasks, nextPosition } from "../../../shared/onboarding.mjs";

type Step = {
  id: string;
  parentId: string | null;
  section: string | null;
  title: string;
  description: string | null;
  position: number;
  isActive: boolean;
};
// groupTasks (pure, in shared/) returns rows with children + a derived done; typed loosely there, so the
// concrete shape is asserted here.
type Group = Step & { children: Step[]; done: boolean };

export default function OnboardingTemplatePage() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSection, setEditSection] = useState("");
  const [editDesc, setEditDesc] = useState("");

  const [addSubFor, setAddSubFor] = useState<string | null>(null);
  const [subTitle, setSubTitle] = useState("");

  const [newTitle, setNewTitle] = useState("");
  const [newSection, setNewSection] = useState("");

  const reload = async () => {
    try {
      const response = await fetch("/api/onboarding/template", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(payload.steps)) setSteps(payload.steps);
    } catch { /* keep what we have */ }
    setLoading(false);
  };
  useEffect(() => { void reload(); }, []);

  const groups = useMemo(() => groupTasks(steps) as Group[], [steps]);

  const patch = async (body: unknown) => {
    setBusy(true);
    try {
      await fetch("/api/onboarding/template", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await reload();
    } finally { setBusy(false); }
  };
  const post = async (body: unknown) => {
    setBusy(true);
    try {
      await fetch("/api/onboarding/template", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await reload();
    } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!window.confirm("Delete this step? Its sub-steps go with it. Clients already onboarding keep their copy.")) return;
    setBusy(true);
    try {
      await fetch("/api/onboarding/template", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      await reload();
    } finally { setBusy(false); }
  };

  // Move a step within its sibling group; hand the server the new order of ids to re-space.
  const move = (siblings: Step[], index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= siblings.length) return;
    const ids = siblings.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved);
    void patch({ reorder: ids });
  };

  const beginEdit = (step: Step) => {
    setEditingId(step.id);
    setEditTitle(step.title);
    setEditSection(step.section || "");
    setEditDesc(step.description || "");
    setAddSubFor(null);
  };
  const saveEdit = () => {
    if (!editingId || !editTitle.trim()) return;
    void patch({ id: editingId, title: editTitle.trim(), section: editSection.trim(), description: editDesc.trim() });
    setEditingId(null);
  };

  const addSub = (parent: { id: string; section: string | null; children: Step[] }) => {
    if (!subTitle.trim()) return;
    void post({ title: subTitle.trim(), parentId: parent.id, section: parent.section, position: nextPosition(parent.children) });
    setSubTitle("");
    setAddSubFor(null);
  };
  const addTop = () => {
    if (!newTitle.trim()) return;
    void post({ title: newTitle.trim(), section: newSection.trim() || null, position: nextPosition(groups) });
    setNewTitle("");
    setNewSection("");
  };

  // A plain render function, not a nested component: rendered as {renderEditForm()} it stays part of this
  // component's tree, so typing in it does not remount the inputs and drop focus every keystroke.
  const renderEditForm = () => (
    <div className="onb-tpl-edit">
      <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Step title" />
      <input value={editSection} onChange={(e) => setEditSection(e.target.value)} placeholder="Section (optional)" />
      <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description / notes (optional)" />
      <div className="onb-tpl-edit-actions">
        <button className="primary-button" onClick={saveEdit} disabled={busy || !editTitle.trim()}>Save</button>
        <button className="text-button" onClick={() => setEditingId(null)}>Cancel</button>
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Link href="/onboarding" className="onb-back">← Onboarding</Link>
        </header>
        <main className="onboarding-shell">
          <div className="onboarding-heading">
            <div>
              <h1>Onboarding template</h1>
              <p>The master checklist every new client starts from. Reorder, edit, add or remove steps. Changes apply to clients added from here on — clients already onboarding keep the list they started with.</p>
            </div>
          </div>

          {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading template…</p>}

          {!loading && (
            <div className="onb-tpl-list">
              {groups.map((group, index) => {
                const editing = editingId === group.id;
                return (
                  <div key={group.id} className={`onb-tpl-step ${group.isActive === false ? "onb-tpl-inactive" : ""}`}>
                    <div className="onb-tpl-row">
                      <span className="onb-index">{index + 1}</span>
                      <button className="onb-iconbtn" onClick={() => move(groups, index, -1)} disabled={busy || index === 0} aria-label="Move up">↑</button>
                      <button className="onb-iconbtn" onClick={() => move(groups, index, 1)} disabled={busy || index === groups.length - 1} aria-label="Move down">↓</button>
                      <span className="onb-tpl-title">
                        {group.title}
                        {group.description && <small>{group.description}</small>}
                      </span>
                      {group.section && <span className="onb-tpl-sectiontag">{group.section}</span>}
                      <button className="onb-iconbtn" onClick={() => beginEdit(group)} aria-label="Edit">✎</button>
                      <button className="onb-iconbtn" onClick={() => setAddSubFor(addSubFor === group.id ? null : group.id)} aria-label="Add sub-step">＋</button>
                      <button className="onb-iconbtn danger" onClick={() => void remove(group.id)} disabled={busy} aria-label="Delete">✕</button>
                    </div>

                    {editing && renderEditForm()}

                    {group.children.map((child: Step, childIndex: number) => {
                      const childEditing = editingId === child.id;
                      return (
                        <div key={child.id} className="onb-tpl-sub" style={{ marginTop: 8 }}>
                          <div className="onb-tpl-row">
                            <button className="onb-iconbtn" onClick={() => move(group.children, childIndex, -1)} disabled={busy || childIndex === 0} aria-label="Move up">↑</button>
                            <button className="onb-iconbtn" onClick={() => move(group.children, childIndex, 1)} disabled={busy || childIndex === group.children.length - 1} aria-label="Move down">↓</button>
                            <span className="onb-tpl-title">
                              {child.title}
                              {child.description && <small>{child.description}</small>}
                            </span>
                            <button className="onb-iconbtn" onClick={() => beginEdit(child)} aria-label="Edit">✎</button>
                            <button className="onb-iconbtn danger" onClick={() => void remove(child.id)} disabled={busy} aria-label="Delete">✕</button>
                          </div>
                          {childEditing && renderEditForm()}
                        </div>
                      );
                    })}

                    {addSubFor === group.id && (
                      <div className="onb-tpl-addsub onb-tpl-sub">
                        <div className="onb-tpl-edit">
                          <input value={subTitle} placeholder="New sub-step title" onChange={(e) => setSubTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addSub(group); }} />
                          <div className="onb-tpl-edit-actions">
                            <button className="primary-button" onClick={() => addSub(group)} disabled={busy || !subTitle.trim()}>Add sub-step</button>
                            <button className="text-button" onClick={() => { setAddSubFor(null); setSubTitle(""); }}>Cancel</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!loading && (
            <div className="onb-add onb-tpl-addstep">
              <div className="onb-field">
                <label htmlFor="onb-new-title">New step</label>
                <input id="onb-new-title" value={newTitle} placeholder="Step title" onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addTop(); }} />
              </div>
              <div className="onb-field">
                <label htmlFor="onb-new-section">Section</label>
                <input id="onb-new-section" value={newSection} placeholder="optional" onChange={(e) => setNewSection(e.target.value)} />
              </div>
              <button className="primary-button" onClick={addTop} disabled={busy || !newTitle.trim()}>Add step</button>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}
