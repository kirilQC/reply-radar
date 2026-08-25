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
  crmProvider: string | null;
  crmConfigured: boolean;
};

function ReplyRadarSetup({ slug, onConfig }: { slug: string; onConfig?: (c: { slackInternal: string; slackExternal: string }) => void }) {
  const [cfg, setCfg] = useState<RRConfig | null>(null);
  const [bases, setBases] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState({ website: "", messagingDoc: "", slackInternal: "", slackExternal: "", airtableBaseId: "", heyreachApiKey: "", crmProvider: "", crmApiKey: "" });
  const [collapsed, setCollapsed] = useState(true); // the Reply Radar setup starts collapsed — it is reference, not the daily view
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
        setForm({ website: config.website || "", messagingDoc: config.messagingDoc || "", slackInternal: config.slackInternal || "", slackExternal: config.slackExternal || "", airtableBaseId: config.airtableBaseId || "", heyreachApiKey: "", crmProvider: config.crmProvider || "", crmApiKey: "" });
        // Stays collapsed by default whether or not the setup is complete; the operator expands it when
        // they need to change a key, and the checklist below is what they came for.
      }
      const basesPayload = await basesResponse.json().catch(() => ({}));
      if (Array.isArray(basesPayload.bases)) setBases(basesPayload.bases);
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Keep the parent in step with the two channel ids, so the check-off prompt and the client-update
  // panel appear the instant one is entered — without a second fetch of the same config.
  useEffect(() => { onConfig?.({ slackInternal: form.slackInternal.trim(), slackExternal: form.slackExternal.trim() }); }, [form.slackInternal, form.slackExternal, onConfig]);

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
    const body: Record<string, string> = { website: form.website, messagingDoc: form.messagingDoc, slackInternal: form.slackInternal, slackExternal: form.slackExternal, airtableBaseId: form.airtableBaseId, crmProvider: form.crmProvider };
    if (form.heyreachApiKey.trim()) body.heyreachApiKey = form.heyreachApiKey.trim();
    if (form.crmApiKey.trim()) body.crmApiKey = form.crmApiKey.trim();
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
          <div className="rr-field rr-field-optional">
            <label htmlFor="rr-crm-provider">Client CRM API key <em>optional — not required to complete</em></label>
            <div className="rr-crm-row">
              <select id="rr-crm-provider" value={form.crmProvider} onChange={(e) => setForm((f) => ({ ...f, crmProvider: e.target.value }))}>
                <option value="">No CRM</option>
                <option value="hubspot">HubSpot</option>
                <option value="attio">Attio</option>
              </select>
              <input type="password" value={form.crmApiKey} placeholder={cfg?.crmConfigured ? "Saved — leave blank to keep" : "Paste the client's CRM key"} onChange={(e) => setForm((f) => ({ ...f, crmApiKey: e.target.value }))} />
            </div>
          </div>
          {cfg?.webhookUrl && (
            <div className="rr-webhook">
              <span>HeyReach webhook (incoming replies)</span>
              <code>{cfg.webhookUrl}</code>
              <button className="secondary-button" onClick={() => { navigator.clipboard?.writeText(cfg.webhookUrl || "").then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>{copied ? "Copied" : "Copy"}</button>
            </div>
          )}
          <MeetingsWebhookRow />
          <div className="rr-actions">
            <button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save setup"}</button>
            {saved && <span className="rr-saved">Saved.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// The one unified meetings webhook. It lives inside the Reply Radar setup panel now — the same URL for
// every client, given to Zapier/Calendly, which routes by the `client` field. Styled as a setup row so
// it reads as part of the same block as the HeyReach webhook above it.
function MeetingsWebhookRow() {
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
    <div className="rr-webhook">
      <span>Meetings webhook (booked meetings)</span>
      <code>{url}</code>
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
  const [slack, setSlack] = useState({ slackInternal: "", slackExternal: "" });
  /** A task just ticked, offered up for a quick Slack note — dismissed or sent. */
  const [prompt, setPrompt] = useState<Task | null>(null);

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
      if (!response.ok) { setTasks(before); return; }
      // Ticking a box (not un-ticking) offers a one-line Slack update — but only when there is an
      // internal channel to send it to. No channel, no prompt.
      if (next && slack.slackInternal) setPrompt(task);
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

              <ReplyRadarSetup slug={slug} onConfig={setSlack} />

              {slack.slackExternal && <ClientUpdatePanel slug={slug} clientName={client.name} />}

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

              {prompt && (
                <SlackTaskPrompt task={prompt} clientName={client.name} slug={slug} onClose={() => setPrompt(null)} />
              )}

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

/**
 * The check-off prompt: a small dialog after a task is ticked, offering a quick note to the internal
 * Slack channel. Pre-filled with a sensible line the operator can edit, and entirely optional — dismiss
 * and nothing is sent. It only ever appears when an internal channel id is on the client.
 */
function SlackTaskPrompt({ task, clientName, slug, onClose }: { task: Task; clientName: string; slug: string; onClose: () => void }) {
  const [text, setText] = useState(`✅ ${clientName} onboarding — ${task.title} is done.`);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const send = async () => {
    if (sending || !text.trim()) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/onboarding/notify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, target: "internal", text }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setError(typeof payload.error === "string" ? payload.error : "Slack rejected it."); setSending(false); return; }
      onClose();
    } catch { setError("Could not reach Slack."); setSending(false); }
  };

  return (
    <div className="onb-modal-back">
      <button className="onb-modal-scrim" aria-label="Dismiss" onClick={onClose} />
      <div className="onb-modal" role="dialog" aria-label="Send a Slack update">
        <h3>Send an update to Slack?</h3>
        <p>Post a quick note to {clientName}&apos;s internal channel that this task is done.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
        {error && <div className="onb-modal-err">{error}</div>}
        <div className="onb-modal-actions">
          <button className="secondary-button" onClick={onClose}>No, skip</button>
          <button className="primary-button" onClick={() => void send()} disabled={sending || !text.trim()}>{sending ? "Sending…" : "Send to Slack"}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Premade client-facing onboarding updates, sent to the external (client) Slack channel.
 *
 * A dropdown of starting points, an editable body, one send. The templates are deliberately simple and
 * meant to be edited before sending — a real update, in QC's voice, not an auto-message. Only rendered
 * when an external channel id is on the client.
 */
const CLIENT_TEMPLATES: { label: string; body: (client: string) => string }[] = [
  { label: "Kickoff — we're live", body: (c) => `Hi team 👋 We've officially kicked off ${c}'s outbound program. Our senders are warming up and the first campaigns go out shortly — we'll keep you posted here as things move.` },
  { label: "Campaigns launched", body: () => `Quick update — your first campaigns are now live and reaching prospects. Early replies usually start landing within a few days; we'll flag the good ones as they come in.` },
  { label: "First replies in", body: () => `Good news — the first replies are coming in. We're reviewing and prioritising the warm ones now, and we'll surface anything that looks like a real opportunity.` },
  { label: "Weekly check-in", body: () => `Weekly update: campaigns are running smoothly and volume is on track. We'll walk through the numbers together on our next call — anything you'd like us to dig into beforehand?` },
  { label: "Blank message", body: () => "" },
];

function ClientUpdatePanel({ slug, clientName }: { slug: string; clientName: string }) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(0);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const pick = (index: number) => {
    setTemplate(index);
    setText(CLIENT_TEMPLATES[index].body(clientName));
    setSent(false);
  };

  const send = async () => {
    if (sending || !text.trim()) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/onboarding/notify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, target: "external", text }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setError(typeof payload.error === "string" ? payload.error : "Slack rejected it."); setSending(false); return; }
      setSent(true); setSending(false); setText("");
    } catch { setError("Could not reach Slack."); setSending(false); }
  };

  return (
    <div className="onb-client-update">
      <button className="onb-cu-head" onClick={() => setOpen((v) => !v)}>
        <span className="onb-cu-title">Client onboarding updates</span>
        <span className="onb-cu-sub">Send a message to {clientName}&apos;s shared channel</span>
        <span className="rr-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="onb-cu-body">
          <span className="onb-cu-label">Start from a template</span>
          <select value={template} onChange={(e) => pick(Number(e.target.value))}>
            {CLIENT_TEMPLATES.map((t, i) => <option key={i} value={i}>{t.label}</option>)}
          </select>
          <textarea value={text} placeholder="Write or edit the update to the client…" rows={4} onChange={(e) => { setText(e.target.value); setSent(false); }} />
          {error && <div className="onb-modal-err">{error}</div>}
          <div className="onb-cu-actions">
            {sent && <span className="onb-cu-sent">Sent ✓</span>}
            <button className="primary-button" onClick={() => void send()} disabled={sending || !text.trim()}>{sending ? "Sending…" : "Send to client channel"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
