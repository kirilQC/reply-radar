// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import { computeProgress, groupTasks } from "../../../shared/onboarding.mjs";

type Task = {
  id: string;
  parentId: string | null;
  section: string | null;
  group: string | null;
  title: string;
  isDone: boolean;
};
type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type Group = Task & { children: Task[]; done: boolean };

const GROUP_ORDER = ["Immediate", "First week", "Least Urgent"];

// ── Reply Radar setup panel ──────────────────────────────────────────────────────────────────────────
type RRConfig = {
  website: string | null;
  messagingDoc: string | null;
  slackInternal: string | null;
  slackExternal: string | null;
  airtableBaseId: string | null;
  webhookUrl: string | null;
  keyConfigured: boolean;
  keyMasked: string;
};

function ReplyRadarSetup({ slug }: { slug: string }) {
  const [cfg, setCfg] = useState<RRConfig | null>(null);
  const [bases, setBases] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState({ website: "", messagingDoc: "", slackInternal: "", slackExternal: "", airtableBaseId: "", heyreachApiKey: "" });
  const [collapsed, setCollapsed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadConfig = async (): Promise<RRConfig | null> => {
    const response = await fetch(`/api/onboarding/reply-radar/${encodeURIComponent(slug)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    return response.ok && payload.config ? (payload.config as RRConfig) : null;
  };

  useEffect(() => {
    void (async () => {
      const [config, basesResponse] = await Promise.all([loadConfig(), fetch("/api/airtable/bases", { cache: "no-store" })]);
      if (config) {
        setCfg(config);
        setForm({ website: config.website || "", messagingDoc: config.messagingDoc || "", slackInternal: config.slackInternal || "", slackExternal: config.slackExternal || "", airtableBaseId: config.airtableBaseId || "", heyreachApiKey: "" });
        const complete = config.keyConfigured && config.messagingDoc && config.website && config.slackInternal && config.slackExternal && config.airtableBaseId;
        setCollapsed(Boolean(complete));
      }
      const basesPayload = await basesResponse.json().catch(() => ({}));
      if (Array.isArray(basesPayload.bases)) setBases(basesPayload.bases);
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const filled = {
    "HeyReach API key": Boolean(cfg?.keyConfigured) || Boolean(form.heyreachApiKey.trim()),
    "Messaging doc URL": Boolean(form.messagingDoc.trim()),
    "Website": Boolean(form.website.trim()),
    "Slack internal ID": Boolean(form.slackInternal.trim()),
    "Slack external ID": Boolean(form.slackExternal.trim()),
    "Airtable base": Boolean(form.airtableBaseId.trim()),
  };
  const doneCount = Object.values(filled).filter(Boolean).length;
  const complete = doneCount === 6;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    const body: Record<string, string> = { website: form.website, messagingDoc: form.messagingDoc, slackInternal: form.slackInternal, slackExternal: form.slackExternal, airtableBaseId: form.airtableBaseId };
    if (form.heyreachApiKey.trim()) body.heyreachApiKey = form.heyreachApiKey.trim();
    try {
      const response = await fetch(`/api/onboarding/reply-radar/${encodeURIComponent(slug)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (response.ok) {
        setSaved(true);
        setForm((f) => ({ ...f, heyreachApiKey: "" }));
        const fresh = await loadConfig();
        if (fresh) setCfg(fresh);
      }
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  const field = (label: keyof typeof filled, node: ReactNode) => (
    <div className="rr-field">
      <label>{label}<i className={filled[label] ? "on" : ""} /></label>
      {node}
    </div>
  );

  return (
    <div className={`rr-setup ${complete ? "complete" : ""}`}>
      <button className="rr-setup-head" onClick={() => setCollapsed((v) => !v)}>
        <span className="rr-setup-title">Reply Radar setup</span>
        {complete ? <span className="rr-setup-badge done">Complete ✓</span> : <span className="rr-setup-badge">{doneCount}/6</span>}
        <span className="rr-caret">{collapsed ? "▾" : "▴"}</span>
      </button>
      {!collapsed && (
        <div className="rr-setup-body">
          <div className="rr-grid">
            {field("HeyReach API key", <input type="password" value={form.heyreachApiKey} placeholder={cfg?.keyConfigured ? `Saved ${cfg.keyMasked} — leave blank to keep` : "Paste the client's HeyReach key"} onChange={(e) => setForm((f) => ({ ...f, heyreachApiKey: e.target.value }))} />)}
            {field("Airtable base", (
              <select value={form.airtableBaseId} onChange={(e) => setForm((f) => ({ ...f, airtableBaseId: e.target.value }))}>
                <option value="">— pick a base —</option>
                {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ))}
            {field("Messaging doc URL", <input value={form.messagingDoc} placeholder="https://docs.google.com/…" onChange={(e) => setForm((f) => ({ ...f, messagingDoc: e.target.value }))} />)}
            {field("Website", <input value={form.website} placeholder="https://client.com" onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} />)}
            {field("Slack internal ID", <input value={form.slackInternal} placeholder="C0123ABCD" onChange={(e) => setForm((f) => ({ ...f, slackInternal: e.target.value }))} />)}
            {field("Slack external ID", <input value={form.slackExternal} placeholder="C0123ABCD" onChange={(e) => setForm((f) => ({ ...f, slackExternal: e.target.value }))} />)}
          </div>
          {cfg?.webhookUrl && (
            <div className="rr-webhook">
              <span>HeyReach webhook (incoming replies)</span>
              <code>{cfg.webhookUrl}</code>
              <button className="secondary-button" onClick={() => { navigator.clipboard?.writeText(cfg.webhookUrl || "").then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>{copied ? "Copied" : "Copy"}</button>
            </div>
          )}
          <div className="rr-actions">
            <button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save setup"}</button>
            {saved && <span className="rr-saved">Saved.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// The one unified meetings webhook, shown per-client for convenience (same URL for every client).
function MeetingsWebhookCard() {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/onboarding/integrations", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload.meetings?.url) setUrl(payload.meetings.url);
      } catch { /* optional */ }
    })();
  }, []);
  if (!url) return null;
  return (
    <div className="onb-ref">
      <span className="onb-ref-label">Meetings webhook</span>
      <code className="onb-ref-url">{url}</code>
      <button className="secondary-button" onClick={() => { navigator.clipboard?.writeText(url).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

// ── The checklist ──────────────────────────────────────────────────────────────────────────────────────
export default function OnboardingChecklistPage() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<Client | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [marking, setMarking] = useState(false);

  const reload = async () => {
    try {
      const response = await fetch(`/api/onboarding/clients/${encodeURIComponent(slug)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.client) { setClient(payload.client); setTasks(Array.isArray(payload.tasks) ? payload.tasks : []); }
    } catch { /* keep current */ }
  };

  const markComplete = async () => {
    if (marking || !window.confirm(`Mark ${client?.name ?? "this client"} as fully onboarded? Every step is checked off.`)) return;
    setMarking(true);
    try {
      const response = await fetch(`/api/onboarding/clients/${encodeURIComponent(slug)}`, { method: "PATCH" });
      if (response.ok) await reload();
    } finally {
      setMarking(false);
    }
  };

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
      } catch { /* leave loading */ }
      setLoading(false);
    })();
  }, [slug]);

  const progress = useMemo(() => computeProgress(tasks), [tasks]);
  const groups = useMemo(() => groupTasks(tasks) as Group[], [tasks]);

  // Bucket the top-level steps under the urgency headers, in order, dropping empty buckets.
  const sections = useMemo(() => {
    const buckets = [...GROUP_ORDER, "Other"].map((name) => ({
      name,
      items: groups.filter((g) => (GROUP_ORDER.includes(g.group || "") ? g.group : "Other") === name),
    }));
    return buckets.filter((b) => b.items.length);
  }, [groups]);

  const toggle = async (task: Task, next: boolean) => {
    const before = tasks;
    setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, isDone: next } : t)));
    try {
      const response = await fetch("/api/onboarding/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id, isDone: next }) });
      if (!response.ok) setTasks(before);
    } catch {
      setTasks(before);
    }
  };

  const done = progress.complete;
  const hue = Math.round(progress.pct * 1.3); // 0 → red, 100 → green
  const fillStyle = { width: `${progress.pct}%`, background: `linear-gradient(90deg, hsl(${Math.max(0, hue - 45)} 85% 60%), hsl(${hue} 82% 50%))` };

  let counter = 0;

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Onboarding", href: "/onboarding" }, { label: client?.name || "Client" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="onboarding-shell">
          {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading checklist…</p>}
          {notFound && !loading && <div className="onb-empty">That client is not in the onboarding hub. <Link href="/onboarding" style={{ color: "var(--accent)" }}>Back</Link>.</div>}

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

              <div className="onb-progress-sticky">
                <div className="onb-bigbar-wrap">
                  <div className="onb-bigbar-meta">
                    <strong>{progress.doneLeaves}<span>/ {progress.totalLeaves} steps done</span></strong>
                    <span className="onb-bigpct" style={{ color: done ? "var(--green)" : `hsl(${hue} 80% 55%)` }}>{done ? "Done 🎉" : `${progress.pct}%`}</span>
                  </div>
                  <div className="onb-bigbar"><span style={fillStyle} /></div>
                </div>
              </div>

              <ReplyRadarSetup slug={slug} />
              <MeetingsWebhookCard />

              {sections.map((section) => (
                <div className="onb-group" key={section.name}>
                  <div className="onb-group-head">{section.name}</div>
                  <div className="onb-list">
                    {section.items.map((group) => {
                      const hasChildren = group.children.length > 0;
                      const rowDone = hasChildren ? group.done : group.isDone;
                      counter += 1;
                      const index = counter;
                      return (
                        <div key={group.id}>
                          <div className={`onb-step ${rowDone ? "done" : ""}`}>
                            <span className="onb-index">{index}</span>
                            <input
                              type="checkbox"
                              className={`onb-checkbox ${hasChildren ? "derived" : ""}`}
                              checked={rowDone}
                              disabled={hasChildren}
                              onChange={(e) => { if (!hasChildren) void toggle(group, e.target.checked); }}
                              aria-label={group.title}
                            />
                            <span className="onb-step-title">{group.title}</span>
                            {group.section && <span className="onb-section-tag">{group.section}</span>}
                          </div>
                          {group.children.map((child) => (
                            <div key={child.id} className={`onb-step onb-sub ${child.isDone ? "done" : ""}`}>
                              <input
                                type="checkbox"
                                className="onb-checkbox"
                                checked={child.isDone}
                                onChange={(e) => void toggle(child, e.target.checked)}
                                aria-label={child.title}
                              />
                              <span className="onb-step-title">{child.title}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {!done && (
                <div className="onb-markdone">
                  <button className="secondary-button" onClick={() => void markComplete()} disabled={marking}>{marking ? "Marking…" : "Mark fully onboarded ✓"}</button>
                </div>
              )}
            </>
          )}
        </main>
      </section>
    </div>
  );
}
