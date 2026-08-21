// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import { computeProgress, groupTasks } from "../../../shared/onboarding.mjs";

type Task = {
  id: string;
  parentId: string | null;
  section: string | null;
  title: string;
  description: string | null;
  position: number;
  isDone: boolean;
  doneBy: string | null;
};
type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; status: string | null };
// groupTasks (pure, in shared/) returns rows with children + a derived done bolted on; it is typed
// loosely there, so the concrete shape is asserted here where the fields are actually read.
type Group = Task & { children: Task[]; done: boolean };

const WHOAMI_KEY = "reply-radar-onboarder";

export default function OnboardingChecklistPage() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<Client | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [whoami, setWhoami] = useState("");

  useEffect(() => {
    try { setWhoami(window.localStorage.getItem(WHOAMI_KEY) || ""); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    if (!slug) return;
    void (async () => {
      try {
        const response = await fetch(`/api/onboarding/clients/${encodeURIComponent(slug)}`, { cache: "no-store" });
        if (response.status === 404) { setNotFound(true); setLoading(false); return; }
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload.client) {
          setClient(payload.client);
          setTasks(Array.isArray(payload.tasks) ? payload.tasks : []);
        }
      } catch { /* leave loading state */ }
      setLoading(false);
    })();
  }, [slug]);

  const progress = useMemo(() => computeProgress(tasks), [tasks]);
  const groups = useMemo(() => groupTasks(tasks) as Group[], [tasks]);

  const saveWhoami = (value: string) => {
    setWhoami(value);
    try { window.localStorage.setItem(WHOAMI_KEY, value); } catch { /* private mode */ }
  };

  const toggle = async (task: Task, next: boolean) => {
    const before = tasks;
    // Optimistic: the checkbox should feel instant. Revert if the write fails.
    setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, isDone: next, doneBy: next ? whoami.trim() || null : null } : t)));
    try {
      const response = await fetch("/api/onboarding/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.id, isDone: next, doneBy: whoami.trim() || undefined }),
      });
      if (!response.ok) setTasks(before);
    } catch {
      setTasks(before);
    }
  };

  const done = progress.complete;

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Link href="/onboarding" className="onb-back">← Onboarding</Link>
        </header>
        <main className="onboarding-shell">
          {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading checklist…</p>}
          {notFound && !loading && (
            <div className="onb-empty">That client is not in the onboarding hub. <Link href="/onboarding" style={{ color: "var(--accent)" }}>Back to the directory</Link>.</div>
          )}

          {client && (
            <>
              <div className="onb-client-head">
                <span className="onb-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
                  {client.logoUrl ? <img src={client.logoUrl} alt="" /> : (client.name[0] || "?").toUpperCase()}
                </span>
                <div>
                  <h1>{client.name}</h1>
                  <Link href="/onboarding" className="onb-back">← All clients</Link>
                </div>
              </div>

              <div className="onb-bigbar-wrap">
                <div className="onb-bigbar-meta">
                  <strong>{progress.doneLeaves}<span>/ {progress.totalLeaves} steps done</span></strong>
                  <span className="onb-pct">{done ? "Complete 🎉" : `${progress.pct}%`}</span>
                </div>
                <div className={`onb-bigbar ${done ? "done" : ""}`}><span style={{ width: `${progress.pct}%` }} /></div>
              </div>

              <div className="onb-whoami">
                <label htmlFor="onb-whoami">Signed in as</label>
                <input id="onb-whoami" value={whoami} placeholder="Your name" onChange={(e) => saveWhoami(e.target.value)} />
                <span>— posted to Slack with each step you complete.</span>
              </div>

              <div className="onb-list">
                {groups.map((group, index) => {
                  const hasChildren = group.children.length > 0;
                  const rowDone = hasChildren ? group.done : group.isDone;
                  return (
                    <div key={group.id}>
                      <div className={`onb-step ${rowDone ? "done" : ""}`}>
                        <span className="onb-index">{index + 1}</span>
                        <input
                          type="checkbox"
                          className={`onb-checkbox ${hasChildren ? "derived" : ""}`}
                          checked={rowDone}
                          disabled={hasChildren}
                          onChange={(e) => { if (!hasChildren) void toggle(group, e.target.checked); }}
                          aria-label={group.title}
                        />
                        <div className="onb-step-body">
                          <span className="onb-step-title">{group.title}</span>
                          {group.description && <span className="onb-step-desc">{group.description}</span>}
                        </div>
                        <div className="onb-step-meta">
                          {!hasChildren && group.doneBy && <span className="onb-done-by">{group.doneBy}</span>}
                          {group.section && <span className="onb-section-tag">{group.section}</span>}
                        </div>
                      </div>
                      {group.children.map((child: Task) => (
                        <div key={child.id} className={`onb-step sub ${child.isDone ? "done" : ""}`}>
                          <input
                            type="checkbox"
                            className="onb-checkbox"
                            checked={child.isDone}
                            onChange={(e) => void toggle(child, e.target.checked)}
                            aria-label={child.title}
                          />
                          <div className="onb-step-body">
                            <span className="onb-step-title">{child.title}</span>
                            {child.description && <span className="onb-step-desc">{child.description}</span>}
                          </div>
                          <div className="onb-step-meta">
                            {child.doneBy && <span className="onb-done-by">{child.doneBy}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </main>
      </section>
    </div>
  );
}
