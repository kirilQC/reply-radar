// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import { groupTasks, nextPosition } from "../../../shared/onboarding.mjs";

type Step = {
  id: string;
  parentId: string | null;
  section: string | null;
  group: string | null;
  title: string;
  description: string | null;
  position: number;
  isActive: boolean;
};
type Group = Step & { children: Step[]; done: boolean };

const GROUPS = ["Immediate", "First week", "Least Urgent"];

// One colour per section, so the ranked list still reads as grouped at a glance without being re-sorted.
const SECTION_COLORS: Record<string, string> = {
  "Contract & kickoff": "#8b7cff",
  "Communication": "#4bb3fd",
  "Data & tooling": "#57c98b",
  "Client access & integrations": "#e6a95b",
  "Reply Radar setup": "#e5738a",
};
const sectionColor = (s?: string | null) => (s && SECTION_COLORS[s]) || "var(--muted)";

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.split("|").map((path, i) => <path key={i} d={path} />)}
    </svg>
  );
}
const IC = {
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  edit: "M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  plus: "M12 5v14|M5 12h14",
  trash: "M4 7h16|M9 7V5h6v2|M6 7l1 13h10l1-13",
};

export default function OnboardingTemplatePage() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSection, setEditSection] = useState("");
  const [editGroup, setEditGroup] = useState("");
  const [editDesc, setEditDesc] = useState("");

  const [addSubFor, setAddSubFor] = useState<string | null>(null);
  const [subTitle, setSubTitle] = useState("");

  const [addingTop, setAddingTop] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newSection, setNewSection] = useState("");
  const [newGroup, setNewGroup] = useState("Immediate");

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

  const send = async (method: string, body: unknown) => {
    setBusy(true);
    try {
      await fetch("/api/onboarding/template", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await reload();
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this step? Its sub-steps go with it. Clients already onboarding keep their copy.")) return;
    await send("DELETE", { id });
  };

  // Move a step within its sibling group; hand the server the new order of ids to re-space.
  const move = (siblings: Step[], index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= siblings.length) return;
    const ids = siblings.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved);
    void send("PATCH", { reorder: ids });
  };

  const beginEdit = (step: Step) => {
    setEditingId(step.id);
    setEditTitle(step.title);
    setEditSection(step.section || "");
    setEditGroup(step.group || "");
    setEditDesc(step.description || "");
    setAddSubFor(null);
  };
  const saveEdit = (isSub: boolean) => {
    if (!editingId || !editTitle.trim()) return;
    // Group is a top-level concept; a sub-step inherits its parent's group, so it is not sent for one.
    void send("PATCH", { id: editingId, title: editTitle.trim(), section: editSection.trim(), description: editDesc.trim(), ...(isSub ? {} : { group: editGroup }) });
    setEditingId(null);
  };

  const addSub = (parent: Group) => {
    if (!subTitle.trim()) return;
    void send("POST", { title: subTitle.trim(), parentId: parent.id, section: parent.section, position: nextPosition(parent.children) });
    setSubTitle("");
    setAddSubFor(null);
  };
  const addTop = () => {
    if (!newTitle.trim()) return;
    void send("POST", { title: newTitle.trim(), section: newSection.trim() || null, group: newGroup, position: nextPosition(groups) });
    setNewTitle("");
    setNewSection("");
    setAddingTop(false);
  };

  const editPanel = (isSub: boolean) => (
    <div className={`onb-tpl-editpanel ${isSub ? "onb-tpl-sub" : ""}`}>
      <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Step title" onKeyDown={(e) => { if (e.key === "Enter") saveEdit(isSub); }} />
      {!isSub && (
        <div className="onb-tpl-editrow">
          <select value={editGroup} onChange={(e) => setEditGroup(e.target.value)}>
            <option value="">No group</option>
            {GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <input value={editSection} onChange={(e) => setEditSection(e.target.value)} placeholder="Section (optional)" />
        </div>
      )}
      <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description / notes (optional)" />
      <div className="onb-tpl-editactions">
        <button className="primary-button" onClick={() => saveEdit(isSub)} disabled={busy || !editTitle.trim()}>Save</button>
        <button className="text-button" onClick={() => setEditingId(null)}>Cancel</button>
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Onboarding", href: "/onboarding" }, { label: "Template" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="onboarding-shell">
          <div className="onboarding-heading">
            <div>
              <div className="eyebrow">Template</div>
              <h1>Onboarding template</h1>
              <p>The master checklist every new client starts from. Reorder, rename, add or remove steps. Changes apply to clients added from here on — clients already onboarding keep the list they started with.</p>
            </div>
          </div>

          {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading template…</p>}

          {!loading && (
            <div className="onb-tpl-list">
              {groups.map((group, index) => (
                <div key={group.id} className={`onb-tpl-step ${group.isActive === false ? "onb-tpl-inactive" : ""}`}>
                  <div className="onb-tpl-row">
                    <span className="onb-tpl-num">{index + 1}</span>
                    <div className="onb-tpl-main">
                      <div className="onb-tpl-name">
                        {group.title}
                        {group.description && <small>{group.description}</small>}
                      </div>
                    </div>
                    {group.group && <span className="onb-tpl-group">{group.group}</span>}
                    {group.section && <span className="onb-tpl-chip" style={{ color: sectionColor(group.section) }}>{group.section}</span>}
                    <div className="onb-tpl-actions">
                      <button className="onb-ic" onClick={() => move(groups, index, -1)} disabled={busy || index === 0} aria-label="Move up"><Icon d={IC.up} /></button>
                      <button className="onb-ic" onClick={() => move(groups, index, 1)} disabled={busy || index === groups.length - 1} aria-label="Move down"><Icon d={IC.down} /></button>
                      <button className="onb-ic" onClick={() => beginEdit(group)} aria-label="Edit"><Icon d={IC.edit} /></button>
                      <button className="onb-ic" onClick={() => { setAddSubFor(addSubFor === group.id ? null : group.id); setSubTitle(""); }} aria-label="Add sub-step"><Icon d={IC.plus} /></button>
                      <button className="onb-ic danger" onClick={() => void remove(group.id)} disabled={busy} aria-label="Delete"><Icon d={IC.trash} /></button>
                    </div>
                  </div>

                  {editingId === group.id && editPanel(false)}

                  {group.children.map((child, childIndex) => (
                    <div key={child.id} className="onb-tpl-sub">
                      <div className="onb-tpl-row">
                        <div className="onb-tpl-main">
                          <div className="onb-tpl-name">
                            {child.title}
                            {child.description && <small>{child.description}</small>}
                          </div>
                        </div>
                        <div className="onb-tpl-actions">
                          <button className="onb-ic" onClick={() => move(group.children, childIndex, -1)} disabled={busy || childIndex === 0} aria-label="Move up"><Icon d={IC.up} /></button>
                          <button className="onb-ic" onClick={() => move(group.children, childIndex, 1)} disabled={busy || childIndex === group.children.length - 1} aria-label="Move down"><Icon d={IC.down} /></button>
                          <button className="onb-ic" onClick={() => beginEdit(child)} aria-label="Edit"><Icon d={IC.edit} /></button>
                          <button className="onb-ic danger" onClick={() => void remove(child.id)} disabled={busy} aria-label="Delete"><Icon d={IC.trash} /></button>
                        </div>
                      </div>
                      {editingId === child.id && editPanel(true)}
                    </div>
                  ))}

                  {addSubFor === group.id && (
                    <div className="onb-tpl-editpanel onb-tpl-sub">
                      <input value={subTitle} placeholder="New sub-step title" onChange={(e) => setSubTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addSub(group); }} />
                      <div className="onb-tpl-editactions">
                        <button className="primary-button" onClick={() => addSub(group)} disabled={busy || !subTitle.trim()}>Add sub-step</button>
                        <button className="text-button" onClick={() => { setAddSubFor(null); setSubTitle(""); }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {addingTop ? (
                <div className="onb-tpl-editpanel" style={{ paddingTop: 14 }}>
                  <input value={newTitle} placeholder="New step title" onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addTop(); }} />
                  <div className="onb-tpl-editrow">
                    <select value={newGroup} onChange={(e) => setNewGroup(e.target.value)}>
                      {GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <input value={newSection} placeholder="Section (optional)" onChange={(e) => setNewSection(e.target.value)} />
                  </div>
                  <div className="onb-tpl-editactions">
                    <button className="primary-button" onClick={addTop} disabled={busy || !newTitle.trim()}>Add step</button>
                    <button className="text-button" onClick={() => { setAddingTop(false); setNewTitle(""); setNewSection(""); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button className="onb-tpl-addrow" onClick={() => setAddingTop(true)}><Icon d={IC.plus} /> Add a step</button>
              )}
            </div>
          )}
        </main>
      </section>
    </div>
  );
}
