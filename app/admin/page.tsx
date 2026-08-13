"use client";
/* eslint-disable @next/next/no-html-link-for-pages, jsx-a11y/label-has-associated-control, react/no-unescaped-entities, react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import { defaultFollowUpPrompt, defaultIcpPrompt, FOLLOW_UP_TEMPLATES, ICP_TEMPLATES, MIN_CLIENT_BRIEF_LENGTH, type ScoringTemplate, templateLabel } from "../lib/scoring-templates";

/** What the breadcrumb calls each configuration section. */
const adminSectionLabels: Record<string, string> = {
  workspaces: "Client directory",
  "ai-hub": "AI",
  ai: "AI context",
  scoring: "Scoring engine",
  heartbeat: "Heartbeat",
  feedback: "Feedback",
  audit: "Audit log",
  theme: "Theme studio",
};

type ClientWorkspace = {
  id?: string;
  name: string;
  slug: string;
  leads: number;
  status: string;
  tone: string;
  lastSync: string;
  createdAt?: string;
  isNew?: boolean;
  brief?: string;
  apiKey?: string;
  timezone?: string;
  keyConfigured?: boolean;
  logoUrl?: string;
  website?: string;
  anthropicModel?: string;
  systemPrompt?: string;
  webhookUrl?: string;
  apiKeyMasked?: string;
  guardrails?: Record<string, unknown>;
};

const initialClients: ClientWorkspace[] = [];
type HeartbeatPayload = {
  status: string;
  checkedAt?: string;
  services: Array<{ id: string; label: string; configured: boolean; explanation?: string }>;
  clients: Array<{ name: string; slug: string; logoUrl?: string | null; keyConfigured: boolean; webhookAgeSeconds: number | null; pollAgeSeconds: number | null; status: string; webhookStatus?: string; pollStatus?: string; lastWebhookReceivedAt?: string | null; lastSuccessfulPollAt?: string | null; recentRuns?: unknown[]; recentEvents?: unknown[]; raw?: Record<string, unknown> }>;
  worker?: { status: string; recordedStatus?: unknown; ageSeconds: number | null; startedAt?: string; finishedAt?: string; durationSeconds?: number | null; workspacesSeen: number; recordsWritten?: unknown; source?: unknown; runType?: unknown; error: string | null; recentRuns?: unknown[]; raw?: Record<string, unknown> } | null;
  thresholds?: Record<string, number>;
  diagnostics?: Record<string, unknown>;
  aiArk?: { status: string; enabled: boolean; configured: boolean; failureThreshold: number; failures24h: number; successes24h: number; calls24h: number; unenrichedLeads24h: number; explanation: string; recentFailures?: unknown[]; recentRuns?: unknown[] };
  error?: string;
};

export default function AdminPage() {
  const [active, setActive] = useState("workspaces");
  const [workspaceClients, setWorkspaceClients] = useState(initialClients);
  const [workspaceStorageReady, setWorkspaceStorageReady] = useState(false);
  const [selected, setSelected] = useState(0);
  const [clientSearch, setClientSearch] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [themePreset, setThemePreset] = useState("midnight");
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [accentOverrides, setAccentOverrides] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = window.localStorage.getItem("reply-radar-admin-accent-overrides");
      return stored ? (JSON.parse(stored) as Record<string, string>) : {};
    } catch { return {}; }
  });
  const logoInput = useRef<HTMLInputElement>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatPayload | null>(null);
  const [heartbeatRefresh, setHeartbeatRefresh] = useState(0);
  const clients = workspaceClients;
  const client = clients[Math.min(selected, Math.max(0, clients.length - 1))] ?? { name: "", slug: "", leads: 0, status: "Not configured", tone: "#8b7cff", lastSync: "not synced" };
  const [workspaceDraft, setWorkspaceDraft] = useState({ name: "", slug: "", brief: "", timezone: "America/New_York", website: "", messagingDocUrl: "", anthropicModel: "", systemPrompt: "", apiKey: "" });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [workspacePassword, setWorkspacePassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const showSavedConfirmation = () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaved(true);
    savedTimer.current = setTimeout(() => setSaved(false), 3_000);
  };
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      try {
        const response = await fetch("/api/admin/workspaces", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!cancelled && response.ok && Array.isArray(payload.workspaces)) {
          const hydratedClients = payload.workspaces.map((item: Record<string, unknown>) => ({
            id: String(item.id ?? ""), name: String(item.name ?? ""), slug: String(item.slug ?? ""), leads: 0,
            status: item.last_successful_poll_at ? "Connected" : "Not configured", tone: String(item.accent_color ?? "var(--accent)"),
            lastSync: String(item.last_successful_poll_at ?? "not synced"), createdAt: String(item.created_at ?? ""),
            brief: String(item.client_brief ?? ""), apiKey: "", apiKeyMasked: String(item.heyreach_api_key_masked ?? ""), timezone: String(item.timezone ?? "America/New_York"), website: String(item.website_url ?? ""), anthropicModel: String(item.anthropic_model ?? ""), systemPrompt: String(item.custom_system_prompt ?? ""), webhookUrl: String(item.webhook_url ?? ""), keyConfigured: Boolean(item.key_configured),
            logoUrl: String(item.logo_url ?? ""),
            guardrails: item.guardrails && typeof item.guardrails === "object" ? item.guardrails as Record<string, unknown> : {},
          }));
          setWorkspaceClients(hydratedClients);
          const requestedClient = new URLSearchParams(window.location.search).get("client");
          const requestedIndex = requestedClient ? hydratedClients.findIndex((item: ClientWorkspace) => item.slug === requestedClient) : -1;
          if (requestedIndex >= 0) { setSelected(requestedIndex); setWorkspaceOpen(true); }
          setWorkspaceStorageReady(true);
          return;
        }
      } catch { /* use the offline cache */ }
      try {
        const saved = window.localStorage.getItem("reply-radar-workspaces:v2");
        if (!cancelled && saved) setWorkspaceClients((JSON.parse(saved) as ClientWorkspace[]).map((item) => ({ ...item, createdAt: item.createdAt ?? "" })));
      } catch { /* keep the empty state */ }
      if (!cancelled) setWorkspaceStorageReady(true);
    };
    void hydrate();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (workspaceStorageReady) window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(workspaceClients));
  }, [workspaceClients, workspaceStorageReady]);
  useEffect(() => {
    if (!workspaceOpen || !client) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */ setWorkspaceDraft({ name: client.name, slug: client.slug, brief: client.brief ?? "", timezone: client.timezone ?? "America/New_York", website: client.website ?? "", messagingDocUrl: String(client.guardrails?.messaging_doc_url ?? ""), anthropicModel: client.anthropicModel ?? "", systemPrompt: client.systemPrompt ?? "", apiKey: "" });
  }, [selected, workspaceOpen]);
  const addWorkspace = () => {
    const next: ClientWorkspace = { name: "", slug: `workspace-${Date.now()}`, leads: 0, status: "Not configured", tone: "#8b7cff", lastSync: "not synced", createdAt: new Date().toISOString(), isNew: true };
    setWorkspaceError("");
    setSaved(false);
    setWorkspaceClients((current) => [...current, next]);
    setSelected(clients.length);
    setWorkspaceOpen(true);
  };
  const saveWorkspaceChanges = async () => {
    setSaving(true);
    setSaved(false);
    setWorkspaceError("");
    const normalizedName = workspaceDraft.name.trim();
    const normalizedSlug = workspaceDraft.slug.trim() || normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || client.slug;
    const logoUrl = logos[client.slug] ?? client.logoUrl ?? "";
    const mutationIdentity = isNewWorkspace ? { create: true } : { id: client.id, previousSlug: client.slug };
    const nextGuardrails = { ...(client.guardrails ?? {}), messaging_doc_url: workspaceDraft.messagingDocUrl.trim() };
    const response = await fetch("/api/admin/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...mutationIdentity, name: normalizedName, slug: normalizedSlug, clientBrief: workspaceDraft.brief, timezone: workspaceDraft.timezone || "America/New_York", websiteUrl: workspaceDraft.website, anthropicModel: workspaceDraft.anthropicModel || null, systemPrompt: workspaceDraft.systemPrompt || null, ...(workspaceDraft.apiKey.trim() ? { heyreachApiKey: workspaceDraft.apiKey.trim() } : {}), logoUrl, accentColor: accentOverrides[client.slug] ?? client.tone, guardrails: nextGuardrails }) }).catch(() => null);
    if (!response?.ok) {
      const detail = await response?.json().catch(() => ({}));
      setWorkspaceError(String(detail?.error ?? "Could not save this workspace. Check Supabase and try again."));
      setSaved(false);
      setSaving(false);
      return;
    }
    const payload = await response.json().catch(() => ({}));
    const savedRow = Array.isArray(payload.workspaces) ? payload.workspaces[0] : null;
    const keyWasSaved = Boolean(workspaceDraft.apiKey.trim()) || client.keyConfigured;
    const next = workspaceClients.map((item, index) => index === selected ? { ...item, id: String(savedRow?.id ?? item.id ?? ""), name: normalizedName, slug: normalizedSlug, brief: workspaceDraft.brief, apiKey: "", apiKeyMasked: savedRow?.heyreach_api_key_masked ?? (workspaceDraft.apiKey.trim() ? `Saved key ••••${workspaceDraft.apiKey.trim().slice(-4)}` : item.apiKeyMasked), keyConfigured: savedRow?.key_configured ?? keyWasSaved, timezone: workspaceDraft.timezone, website: workspaceDraft.website, anthropicModel: workspaceDraft.anthropicModel, tone: accentOverrides[client.slug] ?? item.tone, logoUrl, guardrails: nextGuardrails, isNew: false } : item);
    setWorkspaceClients(next);
    setWorkspaceDraft((draft) => ({ ...draft, apiKey: "" }));
    window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(next));
    window.dispatchEvent(new Event("reply-radar-workspaces-changed"));
    setSaving(false);
    showSavedConfirmation();
  };
  const removeWorkspace = async () => {
    const response = await fetch("/api/admin/workspaces", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: client.id, slug: client.slug }) }).catch(() => null);
    if (!response?.ok) { setPasswordError("Could not delete this workspace from Supabase."); return; }
    const next = clients.filter((_, index) => index !== selected);
    setWorkspaceClients(next);
    window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(next));
    window.dispatchEvent(new Event("reply-radar-workspaces-changed"));
    setSelected(0);
    setWorkspaceOpen(false);
    setSaved(false);
    setPasswordOpen(false);
    setWorkspacePassword("");
  };
  const requestRemoveWorkspace = () => { setPasswordError(""); setWorkspacePassword(""); setPasswordOpen(true); };
  const confirmRemoveWorkspace = async () => {
    if (workspacePassword !== "QueenCity@2026") { setPasswordError("Incorrect password."); return; }
    await removeWorkspace();
  };
  const isNewWorkspace = Boolean(client.isNew);
  const visibleClients = clients
    .filter((item) => item.name.toLowerCase().includes(clientSearch.toLowerCase()) || item.slug.includes(clientSearch.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  useEffect(() => {
    window.localStorage.setItem("reply-radar-admin-accent-overrides", JSON.stringify(accentOverrides));
  }, [accentOverrides]);
  useEffect(() => {
    if (active !== "heartbeat") return;
    fetch("/api/heartbeat", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: HeartbeatPayload) => setHeartbeat(payload))
      .catch(() => setHeartbeat({ status: "error", services: [], clients: [] }));
  }, [active, heartbeatRefresh]);
  const accentColor = accentOverrides[client.slug] ?? client.tone;
  const workspaceLogo = logos[client.slug] ?? client.logoUrl ?? "";
  const setAccentColor = (value: string) =>
    setAccentOverrides((current) => ({ ...current, [client.slug]: value }));
  const chooseLogo = () => logoInput.current?.click();
  const handleLogo = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || file.size > 2 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => {
      const logoUrl = String(reader.result);
      setLogos((current) => ({ ...current, [client.slug]: logoUrl }));
      const next = workspaceClients.map((item, index) => index === selected ? { ...item, logoUrl } : item);
      setWorkspaceClients(next);
      window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(next));
      window.dispatchEvent(new Event("reply-radar-workspaces-changed"));
      void fetch("/api/admin/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: client.id, previousSlug: client.slug, name: client.name, slug: client.slug, clientBrief: client.brief ?? "", timezone: client.timezone ?? "America/New_York", websiteUrl: client.website ?? "", anthropicModel: client.anthropicModel ?? null, logoUrl, accentColor: accentOverrides[client.slug] ?? client.tone }) });
    };
    reader.readAsDataURL(file);
  };
  const copyWebhook = () => {
    void navigator.clipboard?.writeText(client.webhookUrl || `https://reply-radar-mauve.vercel.app/api/webhooks/heyreach/${client.slug}`);
    showSavedConfirmation();
  };
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <main className={`admin-shell admin-theme-${themePreset}`}>
          <header className="admin-topbar">
            <Crumb
              trail={[
                { label: "Configuration", href: "/admin" },
                ...(active === "workspaces"
                  ? workspaceOpen
                    ? [
                        { label: "Client directory", href: "/admin", onClick: (event: React.MouseEvent) => { event.preventDefault(); setWorkspaceOpen(false); } },
                        { label: client.name || "New workspace" },
                      ]
                    : [{ label: "Client directory" }]
                  : [{ label: adminSectionLabels[active] ?? "Theme studio" }]),
              ]}
            />
            <div className="admin-top-actions">
              <GlobalAppearanceControl />
            </div>
          </header>
          <div className="admin-layout">
            <aside className="admin-nav">
              <div className="admin-nav-caption">CONFIGURATION</div>
              <button
                className={active === "workspaces" ? "active" : ""}
                onClick={() => { setActive("workspaces"); setWorkspaceOpen(false); }}
              >
                <span>▦</span>Client directory
              </button>
              <button
                className={active === "ai-hub" ? "active" : ""}
                onClick={() => setActive("ai-hub")}
              >
                <span>✦</span>AI
              </button>
              <div className="admin-nav-caption system-caption">SYSTEM</div>
              {[
                ["feedback", "Feedback", "✎"],
                ["audit", "Audit log", "≡"],
              ].map(([id, label, icon]) => (
                <button
                  key={id}
                  className={active === id ? "active" : ""}
                  onClick={() => setActive(id)}
                >
                  <span>{icon}</span>
                  {label}
                </button>
              ))}
            </aside>
            <section className={`admin-content ${active === "audit" ? "audit-content" : ""}`}>
              {active !== "ai-hub" && <div className="admin-heading">
                <div>
                  <h1 className={active === "workspaces" ? (workspaceOpen ? "client-config-heading" : "workspace-directory-page-title") : undefined}>
                    {active === "workspaces" && workspaceOpen ? <>{workspaceLogo ? <img className="admin-client-heading-logo" src={workspaceLogo} alt="" /> : <span className="admin-client-heading-logo" style={{ background: accentColor }}>{client.name[0] || "?"}</span>}{client.name || "New workspace"}</> : active === "workspaces"
                        ? "Client workspaces"
                        : active === "ai"
                          ? "AI context & voice"
                          : active === "scoring"
                            ? "Scoring engine"
                            : active === "theme"
                              ? "Theme studio"
                              : active === "heartbeat"
                                ? "Heartbeat"
                                : active === "feedback"
                                  ? "Feedback"
                                  : active === "audit"
                                    ? "Audit log"
                                    : "System health"}
                  </h1>
                  {!(active === "workspaces" && workspaceOpen) && active !== "workspaces" && active !== "audit" && <p>
                    {active === "ai"
                          ? "Tune the Anthropic drafting context for every client."
                          : active === "scoring"
                            ? "Make follow-up urgency explainable and client-specific."
                            : active === "heartbeat"
                              ? "Live pulse checks for credentials, webhooks, and sync freshness."
                              : active === "feedback"
                                ? "Report a bug or send an idea. Leave your name off and it stays anonymous."
                              : active === "audit"
                                ? ""
                            : active === "theme"
                              ? "Customize the interface without touching code."
                              : "Verify ingestion and worker reliability across every workspace."}
                  </p>}
                </div>
                {active === "workspaces" && !workspaceOpen && <button
                  className="primary-button"
                  onClick={addWorkspace}
                >
                  + Add workspace
                </button>}
              </div>}
              {workspaceError && active === "workspaces" && <p className="form-error" role="alert">{workspaceError}</p>}
              {active === "heartbeat" && <HeartbeatView heartbeat={heartbeat} onRefresh={() => { setHeartbeat(null); setHeartbeatRefresh((value) => value + 1); }} />}
              {active === "feedback" && <FeedbackView />}
              {active === "audit" && <AuditView />}
              {active === "workspaces" && (
                <>
                  {!workspaceOpen && <div className="workspace-directory">
                    <div className="workspace-directory-heading">
                      <div><strong>Client directory</strong></div>
                      <input aria-label="Search clients" value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Search clients…" />
                    </div>
                    <div className="workspace-directory-list">
                    {visibleClients.map((item) => {
                      const index = clients.findIndex((candidate) => candidate.slug === item.slug);
                      return (
                      <button
                        key={item.slug}
                        className="workspace-card"
                        onClick={() => { setSelected(index); setWorkspaceOpen(true); }}
                      >
                        <i
                          className="workspace-directory-logo"
                          style={item.logoUrl ? undefined : { background: item.tone }}
                        >
                          {item.logoUrl ? <img src={item.logoUrl} alt={`${item.name} logo`} /> : (item.name || "?")[0]}
                        </i>
                        <strong>{item.name || "Unnamed workspace"}</strong>
                      </button>
                    ); })}
                    {!visibleClients.length && <div className="workspace-directory-empty">No clients match your search.</div>}
                    </div>
                  </div>}
                  {workspaceOpen && <div className="workspace-editor-toolbar"><button className="secondary-button" onClick={() => { setWorkspaceError(""); setWorkspaceOpen(false); }}>← Back to directory</button><button className="primary-button" onClick={saveWorkspaceChanges} disabled={saving}>{saving ? "Saving…" : saved ? "Saved ✓" : "Save changes"}</button></div>}
                  {workspaceOpen && <div className="admin-grid">
                    <section className="admin-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>HeyReach connection</h2>
                          <p>
                            Each client gets an isolated API key and webhook
                            endpoint.
                          </p>
                        </div>
                        <span className={isNewWorkspace ? "saved-dot" : "connection-badge"}>
                          <i /> {isNewWorkspace ? "Not configured" : "API healthy"}
                        </span>
                      </div>
                      <label className="field-label">
                        WORKSPACE NAME
                        <input value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="Enter workspace name" />
                      </label>
                      <label className="field-label">
                        HEYREACH API KEY
                        <div className="secret-field">
                          <input
                              value={workspaceDraft.apiKey}
                              onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, apiKey: event.target.value }))}
                              placeholder={client.keyConfigured ? (client.apiKeyMasked || "Saved HeyReach API key · enter a new key to replace") : "Enter HeyReach API key"}
                              type={showKey ? "text" : "password"}
                          />
                          <button onClick={() => setShowKey(!showKey)}>
                            {showKey ? "Hide" : "Reveal"}
                          </button>
                        </div>
                      </label>
                      <div className="field-row">
                        <label className="field-label">
                          WEBHOOK STATUS
                          <div className="status-field">
                            <i /> {isNewWorkspace ? "Not configured" : "Registered · 10 event types"}
                          </div>
                        </label>
                        <label className="field-label">
                          LAST RECONCILIATION
                          <div className="status-field">
                            {isNewWorkspace ? "—" : <>Today, 09:42 AM <span>↻</span></>}
                          </div>
                        </label>
                      </div>
                      <label className="field-label">
                        CLIENT MESSAGING DOC
                        <input value={workspaceDraft.messagingDocUrl} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, messagingDocUrl: event.target.value }))} placeholder="https://docs.google.com/document/d/…" type="url" />
                        <small>Shown as the document shortcut in this client’s inbox.</small>
                      </label>
                      <div className="endpoint-box">
                        <div>
                          <small>WEBHOOK ENDPOINT</small>
                          <code>
                            {client.webhookUrl || `https://reply-radar-mauve.vercel.app/api/webhooks/heyreach/${client.slug || ""}`}
                          </code>
                        </div>
                        <button onClick={copyWebhook}>Copy</button>
                      </div>
                      <div className="panel-actions">
                        <button className="text-button" onClick={() => setActive("audit")}>
                          View event log →
                        </button>
                      </div>
                    </section>
                    <section className="admin-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Client profile</h2>
                          <p>This context powers scoring and reply drafts.</p>
                        </div>
                        <span className="saved-dot">● Auto-saved</span>
                      </div>
                      <label className="field-label">
                        DISPLAY NAME
                        <input value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="Enter display name" />
                      </label>
                      <label className="field-label">
                        CLIENT BRIEF
                        <textarea value={workspaceDraft.brief} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, brief: event.target.value }))} placeholder="Add a short client brief" />
                      </label>
                      <div className="field-row">
                        <label className="field-label">
                          TIMEZONE
                          <select value={workspaceDraft.timezone} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, timezone: event.target.value }))}>
                            <option value="America/New_York">Eastern Time — New York (default)</option>
                            <option value="America/Chicago">Central Time — Chicago</option>
                            <option value="America/Los_Angeles">Pacific Time — Los Angeles</option>
                            <option value="Pacific/Honolulu">Hawaii Time — Honolulu</option>
                            <option value="Europe/London">London</option>
                          </select>
                        </label>
                        <label className="field-label">
                          CLIENT WEBSITE
                          <input value={workspaceDraft.website} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, website: event.target.value }))} placeholder="https://client.example" type="url" />
                        </label>
                      </div>
                      <div className="field-row">
                        <label className="field-label">
                          WORKSPACE SLUG
                          <input value={workspaceDraft.slug} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, slug: event.target.value }))} placeholder="Enter workspace slug" />
                        </label>
                      </div>
                    </section>
                  </div>}
                    {workspaceOpen && <div className="client-config-sections">
                    <section className="admin-panel client-config-section" id="client-theme">
                      <div className="panel-heading"><div><h2>Theme & logo</h2><p>Brand this client's workspace without changing other clients.</p></div><span className="saved-dot">● Auto-saved</span></div>
                      <div className="logo-drop">{workspaceLogo ? <img className="logo-sample" src={workspaceLogo} alt={`${client.name} logo`} /> : <div className="logo-sample" style={{ background: accentColor }}>{client.name[0] || "?"}</div>}<div><strong>Upload client logo</strong><small>SVG, PNG, JPG · max 2MB</small></div><button className="secondary-button" type="button" onClick={chooseLogo}>Choose file</button><input ref={logoInput} type="file" accept="image/png,image/jpeg,image/svg+xml" hidden onChange={handleLogo} /></div>
                      <label className="field-label">CLIENT ACCENT<input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} /></label>
                    </section>
                  </div>}
                  {workspaceOpen && <div className="workspace-config-footer"><div className="workspace-created-meta">Created {client.createdAt ? new Date(client.createdAt).toLocaleDateString() : "—"}</div>{!isNewWorkspace && <button className="remove-workspace-button" onClick={requestRemoveWorkspace}>Remove workspace</button>}</div>}
                </>
              )}
              {active === "ai-hub" && <AiHubView />}
              {active === "ai" && (
                <div className="admin-grid">
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Anthropic configuration</h2>
                        <p>
                          Drafting and scoring for {client.name} run through the
                          Anthropic API.
                        </p>
                      </div>
                      <span className="connection-badge">
                        <i /> Connected
                      </span>
                    </div>
                    <label className="field-label">
                      MODEL
                      <select defaultValue="">
                        <option value="">Select model</option>
                        <option>claude-opus-4-1-20250805</option>
                        <option>claude-opus-4-6</option>
                        <option>claude-sonnet-4-6</option>
                        <option>claude-haiku-4-5-20251001</option>
                      </select>
                    </label>
                    <label className="field-label">
                      ANTHROPIC API KEY
                      <div className="secret-field">
                        <input value="sk-ant-api03-••••••••••••••••" readOnly />
                        <button>Reveal</button>
                      </div>
                    </label>
                    <div className="field-row">
                      <label className="field-label">
                        TEMPERATURE
                        <input type="number" placeholder="Set temperature" step="0.05" />
                      </label>
                      <label className="field-label">
                        MONTHLY SPEND CAP
                        <input placeholder="Set monthly spend cap" />
                      </label>
                    </div>
                    <div className="usage-meter">
                      <div>
                        <span>Current usage</span>
                        <strong>—</strong>
                      </div>
                      <div>
                        <i style={{ width: "0%" }} />
                      </div>
                    </div>
                  </section>
                </div>
              )}
              {active === "scoring" && (
                <div className="admin-grid">
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Signal weights</h2>
                        <p>Adjust how {client.name}'s queue is ranked.</p>
                      </div>
                      <span className="saved-dot">● Draft config</span>
                    </div>
                    {["Unanswered question", "Reply depth", "Meeting language", "Response speed", "Time decay"].map((name) => (
                      <div className="range-row" key={name}>
                        <div>
                          <span>{name}</span>
                          <strong>—</strong>
                        </div>
                        <input
                          type="range"
                          defaultValue="0"
                        />
                      </div>
                    ))}
                    <div className="preview-score">
                      <span>Preview with current rules</span>
                      <strong>
                        No synced lead data <b>—</b>
                      </strong>
                      <small>
                        No synced conversation is available yet.
                      </small>
                    </div>
                  </section>
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Tier thresholds</h2>
                        <p>Labels are always paired with score and reason.</p>
                      </div>
                    </div>
                    <div className="threshold hot-threshold">
                      <span>HOT</span>
                      <input placeholder="Set threshold" />
                      <small>Priority reply within 24 hours</small>
                    </div>
                    <div className="threshold warm-threshold">
                      <span>WARM</span>
                      <input placeholder="Set threshold" />
                      <small>Follow up this week</small>
                    </div>
                    <div className="threshold nurture-threshold">
                      <span>NURTURE</span>
                      <input placeholder="Set threshold" />
                      <small>Keep warm or snooze</small>
                    </div>
                    <div className="threshold dead-threshold">
                      <span>DEAD</span>
                      <input placeholder="Set threshold" />
                      <small>No action required</small>
                    </div>
                  </section>
                </div>
              )}
              {active === "theme" && (
                <div className="admin-grid">
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Theme presets</h2>
                        <p>
                          Theme and branding settings for {client.name} only.
                        </p>
                      </div>
                    </div>
                    <div className="theme-presets">
                      <button
                        onClick={() => setThemePreset("midnight")}
                        className={`theme-preview midnight-preview ${themePreset === "midnight" ? "selected" : ""}`}
                      >
                        <span />
                        Midnight
                      </button>
                      <button
                        onClick={() => setThemePreset("slate")}
                        className={`theme-preview slate-preview ${themePreset === "slate" ? "selected" : ""}`}
                      >
                        <span />
                        Slate
                      </button>
                      <button
                        onClick={() => setThemePreset("paper")}
                        className={`theme-preview paper-preview ${themePreset === "paper" ? "selected" : ""}`}
                      >
                        <span />
                        Paper
                      </button>
                      <button
                        onClick={() => setThemePreset("contrast")}
                        className={`theme-preview contrast-preview ${themePreset === "contrast" ? "selected" : ""}`}
                      >
                        <span />
                        High contrast
                      </button>
                    </div>
                    <div className="field-row">
                      <label className="field-label">
                        ACCENT COLOR
                        <input
                          type="color"
                          value={accentColor}
                          onChange={(event) =>
                            setAccentColor(event.target.value)
                          }
                        />
                      </label>
                      <label className="field-label">
                        ROW DENSITY
                        <select defaultValue="">
                          <option value="">Select row density</option>
                          <option>Compact</option>
                          <option>Comfortable</option>
                          <option>Spacious</option>
                        </select>
                      </label>
                    </div>
                  </section>
                  <section className="admin-panel token-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Workspace branding</h2>
                        <p>{client.name} override</p>
                      </div>
                    </div>
                    <div className="logo-drop">
                      {workspaceLogo ? (
                        <img
                          className="logo-sample"
                          src={workspaceLogo}
                          alt={`${client.name} logo`}
                        />
                      ) : (
                        <div
                          className="logo-sample"
                          style={{ background: client.tone }}
                        >
                          {client.name[0]}
                        </div>
                      )}
                      <div>
                        <strong>Upload client logo</strong>
                        <small>SVG, PNG, JPG · max 2MB</small>
                      </div>
                      <input
                        ref={logoInput}
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml"
                        onChange={handleLogo}
                        hidden
                      />
                      <button className="secondary-button" type="button" onClick={chooseLogo}>
                        Choose file
                      </button>
                    </div>
                    <label className="field-label">
                      CLIENT ACCENT
                      <input
                        type="text"
                        value={accentColor}
                        onChange={(event) => setAccentColor(event.target.value)}
                      />
                    </label>
                    <div className="contrast-check">
                      <i /> WCAG AA contrast passes <span>6.8:1</span>
                    </div>
                  </section>
                </div>
              )}
            </section>
          </div>
        </main>
      </section>
      {passwordOpen && <div className="help-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-workspace-title"><div className="help-card delete-confirm-card"><button className="help-close" onClick={() => setPasswordOpen(false)} aria-label="Cancel">×</button><h2 id="delete-workspace-title">Remove workspace?</h2><p>This permanently removes {client.name || "this workspace"} from the local workspace directory. Enter the admin password to continue.</p><label className="field-label">ADMIN PASSWORD<input type="password" value={workspacePassword} onChange={(event) => setWorkspacePassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && confirmRemoveWorkspace()} /></label>{passwordError && <p className="delete-password-error">{passwordError}</p>}<div className="delete-confirm-actions"><button className="secondary-button" onClick={() => setPasswordOpen(false)}>Cancel</button><button className="primary-button delete-danger-button" onClick={confirmRemoveWorkspace}>Remove workspace</button></div></div></div>}
    </div>
  );
}

function HeartbeatView({ heartbeat, onRefresh }: { heartbeat: HeartbeatPayload | null; onRefresh: () => void }) {
  const [detail, setDetail] = useState<"basic" | "advanced">("basic");
  const formatAge = (seconds: number | null) => {
    if (seconds === null) return "never";
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${days}d ${hours}h ${minutes}m ${String(secs).padStart(2, "0")}s ago`;
  };
  return (
    <div className="heartbeat-view">
      <div className="heartbeat-summary admin-panel">
        <div><span className="eyebrow"><span className="live-dot" /> LIVE PULSE</span><h2>{heartbeat?.status === "live" ? "Reply Radar finished its checkup" : heartbeat?.status === "not_configured" ? "Setup is not finished" : "Checking Reply Radar…"}</h2><p>Think of this page as a check-engine light for the database, AI, worker, and each client connection.</p></div>
        <div className="health-actions"><div className="segmented-control"><button className={detail === "basic" ? "active" : ""} onClick={() => setDetail("basic")}>Basic view</button><button className={detail === "advanced" ? "active" : ""} onClick={() => setDetail("advanced")}>Advanced view</button></div><button className="secondary-button" onClick={onRefresh}>Refresh checks ↻</button></div>
      </div>
      <div className="heartbeat-service-grid">{(heartbeat?.services ?? []).map((service) => <div className="heartbeat-service admin-panel" key={service.id}><i className={service.configured ? "heartbeat-ok" : "heartbeat-missing"} /><div><strong>{service.label}</strong><small>{service.configured ? "Ready to use" : "Needs setup"}</small><small>{service.explanation}</small></div></div>)}</div>
      <section className="admin-panel"><div className="panel-heading"><div><h2>Worker heartbeat</h2><p>The worker is a robot helper that wakes up, checks every client, and reports what happened.</p></div><span className={`health-state ${heartbeat?.worker?.status === "running" ? "ready" : "missing"}`}>{heartbeat?.worker?.status === "running" ? "Running" : "Needs attention"}</span></div><div className="heartbeat-log-list"><div><strong>Did the helper check in?</strong><span>{heartbeat?.worker ? `Yes — ${formatAge(heartbeat.worker.ageSeconds)}` : "No check-in found yet"}</span></div><div><strong>How many clients did it check?</strong><span>{heartbeat?.worker?.workspacesSeen ?? 0}</span></div><div><strong>Did it finish normally?</strong><span>{heartbeat?.worker?.error ? `No — ${heartbeat.worker.error}` : heartbeat?.worker ? "No error was reported" : "Waiting for the first run"}</span></div></div>{detail === "advanced" && <details className="diagnostic-details" open><summary>Worker timestamps, counters, recent runs, and raw row</summary><pre>{JSON.stringify(heartbeat?.worker ?? null, null, 2)}</pre></details>}</section>
      <section className={`admin-panel ai-ark-health ${heartbeat?.aiArk?.status === "attention" || heartbeat?.aiArk?.status === "not_configured" ? "has-alert" : ""}`}><div className="panel-heading"><div><h2>AI Ark enrichment</h2><p>We compare real API calls with recently stored LinkedIn leads. More than five failures triggers an alert.</p></div><span className={`health-state ${heartbeat?.aiArk?.status === "healthy" ? "ready" : heartbeat?.aiArk?.status === "disabled" ? "neutral" : "missing"}`}>{heartbeat?.aiArk?.status === "healthy" ? "Healthy" : heartbeat?.aiArk?.status === "disabled" ? "Globally disabled" : "Needs attention"}</span></div><p className="ai-ark-health-explanation">{heartbeat?.aiArk?.explanation ?? "Waiting for the first check."}</p><div className="heartbeat-kid-grid ai-ark-health-grid"><div className={heartbeat?.aiArk?.configured || !heartbeat?.aiArk?.enabled ? "ok" : "bad"}><b>{heartbeat?.aiArk?.configured || !heartbeat?.aiArk?.enabled ? "✓" : "!"}</b><span><strong>Global switch and key</strong><small>{heartbeat?.aiArk?.enabled ? heartbeat?.aiArk?.configured ? "Enabled and configured." : "Enabled, but the API key is missing." : "Disabled in Vercel."}</small></span></div><div className={(heartbeat?.aiArk?.failures24h ?? 0) > 5 ? "bad" : "ok"}><b>{(heartbeat?.aiArk?.failures24h ?? 0) > 5 ? "!" : "✓"}</b><span><strong>Calls · last 24 hours</strong><small>{heartbeat?.aiArk?.successes24h ?? 0} successful · {heartbeat?.aiArk?.failures24h ?? 0} failed</small></span></div><div className={(heartbeat?.aiArk?.unenrichedLeads24h ?? 0) > 5 ? "bad" : "ok"}><b>{(heartbeat?.aiArk?.unenrichedLeads24h ?? 0) > 5 ? "!" : "✓"}</b><span><strong>Missing enrichment</strong><small>{heartbeat?.aiArk?.unenrichedLeads24h ?? 0} recent LinkedIn lead(s)</small></span></div></div>{detail === "advanced" && <details className="diagnostic-details" open><summary>AI Ark failures, counts, and raw run records</summary><pre>{JSON.stringify(heartbeat?.aiArk ?? null, null, 2)}</pre></details>}</section>
      <section className="admin-panel"><div className="panel-heading"><div><h2>Client connection heartbeat</h2><p>Each client needs three things: a key, incoming webhook replies, and a recent background poll.</p></div></div><div className="heartbeat-client-list">{heartbeat?.clients?.length ? heartbeat.clients.map((item) => {
        const keyHealthy = item.keyConfigured;
        const webhookHealthy = item.webhookAgeSeconds !== null && item.webhookAgeSeconds <= Number(heartbeat?.thresholds?.webhookFreshSeconds ?? 1800);
        const pollHealthy = item.pollAgeSeconds !== null && item.pollAgeSeconds <= Number(heartbeat?.thresholds?.pollFreshSeconds ?? 3600);
        return <div className="heartbeat-client" key={item.slug}><div className="heartbeat-client-title"><div className="heartbeat-client-name"><i style={item.logoUrl ? undefined : { background: "var(--accent)" }}>{item.logoUrl ? <img src={item.logoUrl} alt={`${item.name} logo`} /> : item.name[0]}</i><strong>{item.name}</strong></div><span className={item.status === "healthy" ? "health-state ready" : "health-state missing"}>{item.status === "healthy" ? "Everything works" : item.status === "missing" ? "API key missing" : "Needs attention"}</span></div><div className="heartbeat-kid-grid"><div className={keyHealthy ? "ok" : "bad"}><b>{keyHealthy ? "✓" : "!"}</b><span><strong>Door key</strong><small>{keyHealthy ? "Reply Radar can ask HeyReach for updates." : "Add this client’s HeyReach key."}</small></span></div><div className={webhookHealthy ? "ok" : "bad"}><b>{webhookHealthy ? "✓" : "!"}</b><span><strong>Incoming replies</strong><small>{item.webhookStatus ?? "No webhook information."}</small></span></div><div className={pollHealthy ? "ok" : "bad"}><b>{pollHealthy ? "✓" : "!"}</b><span><strong>Background check</strong><small>{item.pollStatus ?? "No poll information."}</small></span></div></div>{detail === "advanced" && <details className="diagnostic-details"><summary>Full client timestamps, recent runs, webhook events, and sanitized database row</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>}</div>;
      }) : <div className="heartbeat-empty">No clients were found. Add a client and start the Render worker to begin checks.</div>}</div></section>
      {detail === "advanced" && <section className="admin-panel"><div className="panel-heading"><div><h2>Full diagnostic payload</h2><p>Runtime flags, freshness thresholds, query status codes, timings, row counts, recent sync runs, and webhook events. Secrets are never included.</p></div></div><details className="diagnostic-details" open><summary>Raw heartbeat JSON</summary><pre>{JSON.stringify(heartbeat, null, 2)}</pre></details></section>}
      <p className="heartbeat-last-checked">Last checked {heartbeat?.checkedAt ? new Date(heartbeat.checkedAt).toLocaleString() : "not yet"}</p>
    </div>
  );
}

type FeedbackItem = {
  id: string;
  kind: string;
  message: string;
  submittedBy: string | null;
  page: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};
const feedbackStages = [
  ["new", "New"],
  ["viewed", "Viewed"],
  ["working", "Working on"],
  ["fixed", "Fixed"],
] as const;
const feedbackKinds = [
  ["bug", "Bug"],
  ["idea", "Idea"],
  ["other", "Something else"],
] as const;

function FeedbackView() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<string>("bug");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [signed, setSigned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");

  const load = async () => {
    try {
      const response = await fetch("/api/feedback", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Feedback could not be loaded.");
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Feedback could not be loaded.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const submit = async () => {
    if (!message.trim() || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Only send a name when the reporter opted in, so the anonymous path never
        // depends on the server ignoring a value we shipped anyway.
        body: JSON.stringify({ kind, message, submittedBy: signed ? name : "", page: window.location.pathname }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Submitting failed.");
      setMessage("");
      setSent(true);
      window.setTimeout(() => setSent(false), 4000);
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Submitting failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const setStage = async (item: FeedbackItem, status: string) => {
    // Optimistic, because the only thing a failed PATCH costs is a stale badge and
    // the next load corrects it.
    setItems((current) => current.map((row) => (row.id === item.id ? { ...row, status } : row)));
    const response = await fetch("/api/feedback", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id, status }) });
    if (!response.ok) void load();
  };
  const remove = async (item: FeedbackItem) => {
    setItems((current) => current.filter((row) => row.id !== item.id));
    const response = await fetch("/api/feedback", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id }) });
    if (!response.ok) void load();
  };

  const visible = statusFilter ? items.filter((item) => item.status === statusFilter) : items;
  return (
    <div className="feedback-view">
      <section className="admin-panel">
        <div className="panel-heading"><div><h2>Send feedback</h2><p>Bugs, rough edges, ideas — anything. Your name is only attached if you add it.</p></div></div>
        <div className="feedback-form">
          <div className="feedback-kind">
            {feedbackKinds.map(([value, label]) => (
              <button key={value} type="button" className={kind === value ? "selected" : ""} onClick={() => setKind(value)}>{label}</button>
            ))}
          </div>
          <label className="field-label">WHAT HAPPENED<textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={6} placeholder="What were you doing, what did you expect, and what happened instead?" /></label>
          <div className="feedback-identity">
            <button type="button" className={`feedback-anon-toggle ${signed ? "" : "anonymous"}`} onClick={() => setSigned((value) => !value)}>
              {signed ? "Signing this" : "Staying anonymous"}
            </button>
            {signed && <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" aria-label="Your name" />}
            <button type="button" className="primary-button" onClick={() => void submit()} disabled={submitting || !message.trim()}>
              {submitting ? "Sending…" : "Submit"}
            </button>
          </div>
          {sent && <p className="feedback-sent" role="status">Thanks — that landed.</p>}
        </div>
      </section>
      <section className="admin-panel">
        <div className="panel-heading">
          <div><h2>Submitted feedback</h2><p>{items.length} item{items.length === 1 ? "" : "s"}. Move each one along as you work through it.</p></div>
          <select className="filter-button" aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">All statuses</option>
            {feedbackStages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {loading && <p className="feedback-empty">Loading…</p>}
        {!loading && !visible.length && <p className="feedback-empty">Nothing here yet.</p>}
        <div className="feedback-list">
          {visible.map((item) => (
            <article key={item.id} className={`feedback-card status-${item.status}`}>
              <header>
                <span className={`feedback-kind-tag kind-${item.kind}`}>{feedbackKinds.find(([value]) => value === item.kind)?.[1] ?? item.kind}</span>
                <span className="feedback-byline">{item.submittedBy ?? "Anonymous"}</span>
                <span className="feedback-stamp">{new Date(item.createdAt).toLocaleString()}</span>
                <button type="button" className="feedback-delete" aria-label="Delete this feedback" onClick={() => void remove(item)}>×</button>
              </header>
              <p>{item.message}</p>
              <footer>
                {feedbackStages.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={item.status === value ? "selected" : ""}
                    onClick={() => void setStage(item, value)}
                  >
                    {label}
                  </button>
                ))}
              </footer>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function AuditView() {
  type AuditEvent = { id: string; timestamp: string; source: string; sourceKey: string; action: string; status: string; severity: "success" | "info" | "warning" | "error"; workspace?: string | null; workspaceLogo?: string | null; summary: string; details?: Record<string, unknown> };
  type GroupedItem = { type: "single"; event: AuditEvent } | { type: "group"; events: AuditEvent[]; timestamp: string };
  const pageSize = 24;
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const isWorkspaceSync = (event: AuditEvent) => event.severity === "success" && (event.action.includes("workspace") || event.action.includes("heartbeat") || event.action.includes("sync")) && event.sourceKey === "worker";
  const groupedEvents: GroupedItem[] = useMemo(() => {
    const items: GroupedItem[] = [];
    let syncBuffer: AuditEvent[] = [];
    const flushBuffer = () => {
      if (syncBuffer.length > 1) {
        items.push({ type: "group", events: [...syncBuffer], timestamp: syncBuffer[0].timestamp });
      } else if (syncBuffer.length === 1) {
        items.push({ type: "single", event: syncBuffer[0] });
      }
      syncBuffer = [];
    };
    for (const event of events) {
      if (isWorkspaceSync(event)) {
        syncBuffer.push(event);
      } else {
        flushBuffer();
        items.push({ type: "single", event });
      }
    }
    flushBuffer();
    return items;
  }, [events]);
  useEffect(() => {
    let cancelled = false;
    const load = async (quiet = false) => {
      if (!quiet) setLoading(true);
      const query = new URLSearchParams({ limit: String(visibleCount) });
      if (source) query.set("source", source);
      if (status) query.set("status", status);
      if (search.trim()) query.set("search", search.trim());
      if (from) query.set("from", new Date(from).toISOString());
      if (to) query.set("to", new Date(to).toISOString());
      try {
        const response = await fetch(`/api/admin/audit?${query}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(payload.error || "The audit feed could not be loaded."));
        if (!cancelled) { setEvents(Array.isArray(payload.events) ? payload.events : []); setHasMore(Boolean(payload.hasMore)); setUpdatedAt(String(payload.generatedAt ?? new Date().toISOString())); setError(""); }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The audit feed could not be loaded.");
      } finally { if (!cancelled && !quiet) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [visibleCount, source, status, search, from, to]);
  const exportAudit = () => {
    const csv = ["Timestamp,Source,Workspace,Action,Explanation,Status", ...events.map((event) => [new Date(event.timestamp).toISOString(), event.source, event.workspace ?? "", event.action, event.summary, event.status].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `reply-radar-audit-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="audit-view">
    <div className="audit-toolbar"><div className="audit-filters"><label><span>Search events</span><input value={search} onChange={(event) => { setSearch(event.target.value); setVisibleCount(pageSize); }} placeholder="Client, system, or event…" /></label><label><span>Source</span><select value={source} onChange={(event) => { setSource(event.target.value); setVisibleCount(pageSize); }}><option value="">All sources</option><option value="worker">Background worker</option><option value="heyreach">HeyReach webhook</option><option value="ai_ark">AI Ark</option><option value="supabase">Supabase</option><option value="anthropic">Anthropic</option><option value="admin">Admin console</option><option value="user">Dashboard user</option></select></label><label><span>Status</span><select value={status} onChange={(event) => { setStatus(event.target.value); setVisibleCount(pageSize); }}><option value="">All statuses</option><option value="success">Successful</option><option value="warning">In progress / warning</option><option value="error">Failed</option><option value="info">Recorded</option></select></label><label><span>From</span><input type="datetime-local" value={from} onChange={(event) => { setFrom(event.target.value); setVisibleCount(pageSize); }} /></label><label><span>To</span><input type="datetime-local" value={to} onChange={(event) => { setTo(event.target.value); setVisibleCount(pageSize); }} /></label></div><div className="audit-actions"><div className="audit-live"><i /><span>Live · refreshes every 5 seconds{updatedAt ? <small>Updated {new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</small> : null}</span></div><button className="secondary-button" onClick={exportAudit} disabled={!events.length}>Export CSV ↓</button></div></div>
    {error && <p className="audit-error">{error}</p>}
    <div className="audit-table"><div className="audit-table-head"><span>When</span><span>Source</span><span>What happened</span><span>Status</span></div>{loading && !events.length ? <p className="audit-empty">Loading the live audit feed…</p> : groupedEvents.map((item) => {
      if (item.type === "single") {
        const event = item.event;
        return <article className={`audit-row ${event.severity}`} key={event.id}><time>{new Date(event.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</time><div className="audit-source">{event.workspaceLogo ? <img src={event.workspaceLogo} alt={`${event.workspace ?? "Client"} logo`} /> : <i />}<span><strong>{event.source}</strong>{event.workspace && <small>{event.workspace}</small>}</span></div><div className="audit-description"><strong>{event.action.replaceAll("_", " ").replaceAll(".", " · ")}</strong><p>{event.summary}</p><details><summary>Technical details</summary><pre>{JSON.stringify(event.details ?? {}, null, 2)}</pre></details></div><span className={`audit-status ${event.severity}`}>{event.status}</span></article>;
      }
      const groupKey = item.timestamp;
      const expanded = expandedGroups.has(groupKey);
      const clients = item.events.map((event) => event.workspace).filter(Boolean);
      return <div className="audit-group-row" key={groupKey}>
        <button className={`audit-group-toggle ${expanded ? "expanded" : ""}`} onClick={() => setExpandedGroups((current) => { const next = new Set(current); if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey); return next; })}>
          <time>{new Date(item.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</time>
          <div className="audit-source"><i /><span><strong>worker</strong><small>{item.events.length} syncs</small></span></div>
          <div className="audit-description"><strong>workspace sync batch</strong><p>{clients.length} client{clients.length !== 1 ? "s" : ""} synced successfully{clients.length ? ` — ${clients.join(", ")}` : ""}</p></div>
          <span className="audit-status success">success</span>
          <span className="audit-group-chevron">▾</span>
        </button>
        {expanded && <div className="audit-group-children">{item.events.map((event) => <article className={`audit-row ${event.severity}`} key={event.id}><time>{new Date(event.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</time><div className="audit-source">{event.workspaceLogo ? <img src={event.workspaceLogo} alt={`${event.workspace ?? "Client"} logo`} /> : <i />}<span><strong>{event.source}</strong>{event.workspace && <small>{event.workspace}</small>}</span></div><div className="audit-description"><strong>{event.action.replaceAll("_", " ").replaceAll(".", " · ")}</strong><p>{event.summary}</p><details><summary>Technical details</summary><pre>{JSON.stringify(event.details ?? {}, null, 2)}</pre></details></div><span className={`audit-status ${event.severity}`}>{event.status}</span></article>)}</div>}
      </div>;
    })}{!loading && !events.length && !error && <p className="audit-empty">No real events match these filters yet.</p>}{hasMore && <button className="audit-see-more" onClick={() => setVisibleCount((count) => count + pageSize)}>See 24 more events ↓</button>}</div>
  </section>;
}

type AiConfig = {
  anthropic: { configured: boolean; maskedKey: string | null; model: string };
  globalSentimentPrompt: string;
  defaultSentimentPrompt: string;
  workspaceAi: { name: string; slug: string; brief: string; model: string; icpPrompt: string; followUpPrompt: string; replyPrompt: string; sentimentPrompt: string; followUpThreshold?: number } | null;
  workspaces: Array<{ id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; hasBrief: boolean }>;
};
type PastReplyRef = { body: string; senderName: string; leadName: string; campaignName: string };
type AiAuditEvent = { id: string; timestamp: string; action: string; status: string; sentiment: string | null; inputTokens: number; outputTokens: number; durationMs: number | null; workspaceName: string | null; workspaceLogoUrl: string | null; leadName: string | null; leadPhotoUrl: string | null; conversationId?: string | null; draft?: string | null; reason?: string | null; inboundMessage?: string | null; campaignName?: string | null; leadTitle?: string | null; leadCompany?: string | null; pastReplies?: string[]; pastReplyContext?: PastReplyRef[] };
type AiAuditData = { ok?: boolean; events: AiAuditEvent[]; drafts?: AiAuditEvent[]; summary: { totalCalls: number; successful: number; failed: number; totalInputTokens: number; totalOutputTokens: number } };

/**
 * Vetted prompts offered as a choice, with the current one named.
 *
 * The label is derived from the text rather than remembered from the last click, so editing a
 * template's wording immediately reports it as "Custom" — a teammate can always tell whether the AI
 * is running something we vetted or something they wrote.
 */
function TemplatePicker({ templates, value, onPick, onSave, onDelete }: {
  templates: ScoringTemplate[];
  value: string;
  onPick: (prompt: string) => void;
  onSave: (name: string) => Promise<string>;
  onDelete: (id: string) => void;
}) {
  const current = templateLabel(templates, value);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement | null>(null);
  // Focused on appearance rather than through autoFocus, which would also steal focus on page load.
  useEffect(() => { if (naming) nameInput.current?.focus(); }, [naming]);
  const commit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const failure = await onSave(name.trim());
    setBusy(false);
    if (failure) { setError(failure); return; }
    setNaming(false); setName(""); setError("");
  };
  return <div className="template-picker">
    <div className="template-picker-head"><span className="field-label" style={{ margin: 0 }}>START FROM A TEMPLATE</span><b className={current.id ? "template-badge" : "template-badge custom"}>{current.name}</b></div>
    <div className="template-picker-grid">
      {templates.map((template) => <div key={template.id} className={`template-card${current.id === template.id ? " active" : ""}`} role="button" tabIndex={0}
        onClick={() => onPick(template.prompt)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick(template.prompt); } }}
      >
        <strong>{template.name}{template.saved && <span className="template-saved-tag">Saved</span>}</strong>
        {template.summary && <p>{template.summary}</p>}
        {template.tracks && <small><em>Tracks:</em> {template.tracks}</small>}
        {template.saved && <button type="button" className="template-delete" title="Delete this saved template"
          onClick={(event) => { event.stopPropagation(); onDelete(template.id); }}
        >×</button>}
      </div>)}
      {naming
        // Named inline rather than through a browser prompt, which cannot be styled, cannot show why
        // a save failed, and cannot be cancelled without losing what was typed.
        ? <div className="template-card template-card-naming">
            <input ref={nameInput} value={name} placeholder="Template name" maxLength={80}
              onChange={(event) => { setName(event.target.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(); } if (event.key === "Escape") { setNaming(false); setName(""); setError(""); } }} />
            {error ? <small className="template-error">{error}</small> : <small>Saving under a name already in use replaces it.</small>}
            <div className="template-naming-actions">
              <button type="button" className="primary-button" disabled={!name.trim() || busy} onClick={() => void commit()}>{busy ? "Saving…" : "Save"}</button>
              <button type="button" className="text-button" onClick={() => { setNaming(false); setName(""); setError(""); }}>Cancel</button>
            </div>
          </div>
        : <button type="button" className="template-card template-card-add" onClick={() => setNaming(true)} disabled={!value.trim()}>
            <span>＋</span>
            <strong>Save this prompt as a template</strong>
            <p>{value.trim() ? "Keeps it in this list for every client." : "Write a prompt below first."}</p>
          </button>}
    </div>
    <small className="template-picker-hint">Pick one to fill the box below, then edit it freely — any change makes it a custom prompt for this client. Editing and saving changes is enough to use a custom prompt; only save it as a template if other clients should be able to pick it too.</small>
  </div>;
}

/**
 * Live feed of Anthropic suggested-reply generations. Shows the past client replies that
 * were fed in as tone reference and the draft that came out, with client + lead photos.
 *
 * The AI hub already polls /api/ai/audit every 3s and highlights fresh rows for 2s,
 * so surfacing the same event stream here — filtered to drafting events and expanded
 * with the raw draft text and voice examples — is enough to feel live without adding
 * another polling loop.
 */
function DraftFeedPanel({ events, freshIds }: { events: AiAuditEvent[]; freshIds: string[] }) {
  const [visible, setVisible] = useState(10);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Only show events with the full v2 payload (inbound message, references, etc.).
  // Older rows still appear in the raw audit log below, but rendering them here
  // would show a half-empty card.
  const allDrafts = events.filter((event) => {
    if (event.action !== "conversation.analyzed" && event.action !== "draft.generated" && event.action !== "draft.failed") return false;
    if (event.action === "draft.failed") return true;
    const hasDraft = Boolean(event.draft && event.draft.trim());
    const hasInbound = Boolean(event.inboundMessage && event.inboundMessage.trim());
    return hasDraft && hasInbound;
  });
  const drafts = allDrafts.slice(0, visible);
  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  return (
    <section className="admin-panel ai-draft-feed-section">
      <div className="panel-heading">
        <div className="ai-audit-title">
          <h2 style={{ fontSize: 22 }}>Suggested reply feed</h2>
          <span className="ai-audit-live"><i />live</span>
        </div>
      </div>
      {drafts.length === 0 ? (
        <p className="audit-empty">No drafts yet. New generations will stream in here.</p>
      ) : (
        <div className="ai-draft-feed">
          {drafts.map((event) => {
            const d = event.timestamp ? new Date(event.timestamp) : null;
            const when = d && !Number.isNaN(d.getTime())
              ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
              : "—";
            const date = d && !Number.isNaN(d.getTime())
              ? `${d.getMonth() + 1}/${d.getDate()}`
              : "";
            const isFresh = freshIds.includes(String(event.id));
            const isFailed = event.action === "draft.failed" || event.status === "error" || event.status === "failed";
            const isOpen = Boolean(expanded[String(event.id)]);
            const references = event.pastReplyContext ?? [];
            // Compose the sub-line: title @ company, then campaign
            const titleCompany = [event.leadTitle, event.leadCompany].filter(Boolean).join(" @ ");
            return (
              <article className={`ai-draft-card${isFresh ? " ai-draft-card-fresh" : ""}${isFailed ? " ai-draft-card-failed" : ""}${isOpen ? " ai-draft-card-open" : ""}`} key={event.id}>
                <button type="button" className="ai-draft-card-toggle" onClick={() => toggle(String(event.id))} aria-expanded={isOpen}>
                  <header className="ai-draft-card-head">
                    <div className="ai-draft-card-who">
                      <div className="ai-draft-avatar-pair">
                        {event.leadPhotoUrl ? <img className="ai-draft-avatar-lead" src={event.leadPhotoUrl} alt="" /> : <span className="ai-draft-avatar-placeholder">{(event.leadName ?? "?")[0]}</span>}
                        {event.workspaceLogoUrl ? <img className="ai-draft-avatar-client" src={event.workspaceLogoUrl} alt="" /> : <span className="ai-draft-avatar-placeholder ai-draft-avatar-client">{(event.workspaceName ?? "?")[0]}</span>}
                      </div>
                      <div className="ai-draft-card-identity">
                        <strong>{event.leadName || "—"}</strong>
                        {titleCompany && <span className="ai-draft-card-role">{titleCompany}</span>}
                        <small>
                          {event.workspaceName || "—"}
                          {event.campaignName ? ` · ${event.campaignName}` : ""}
                          {` · ${date} ${when}`}
                        </small>
                      </div>
                    </div>
                    <div className="ai-draft-card-meta">
                      {event.sentiment && <span className={`sentiment-badge sentiment-${event.sentiment}`}>{event.sentiment}</span>}
                      <small>{event.durationMs ? `${event.durationMs}ms` : ""}</small>
                      <small>{event.inputTokens || event.outputTokens ? `${event.inputTokens}→${event.outputTokens}` : ""}</small>
                      <span className="ai-draft-card-caret" aria-hidden>{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </header>
                  <div className="ai-draft-block ai-draft-block-output">
                    <span className="ai-draft-block-label">SUGGESTED REPLY</span>
                    <p>{event.draft || (isFailed ? "Draft failed to generate." : "(empty)")}</p>
                  </div>
                </button>
                {isOpen && (
                  <div className="ai-draft-card-details">
                    {event.inboundMessage && (
                      <div className="ai-draft-block ai-draft-block-inbound">
                        <span className="ai-draft-block-label">INBOUND MESSAGE (what we&apos;re replying to)</span>
                        <p>{event.inboundMessage}</p>
                      </div>
                    )}
                    {event.reason && (
                      <div className="ai-draft-block ai-draft-block-reason">
                        <span className="ai-draft-block-label">WHY THIS DESERVES ATTENTION</span>
                        <p>{event.reason}</p>
                      </div>
                    )}
                    {references.length > 0 && (
                      <div className="ai-draft-block ai-draft-block-input">
                        <span className="ai-draft-block-label">
                          VOICE REFERENCE · {references.length} past reply from this client
                        </span>
                        <ol className="ai-draft-references">
                          {references.map((ref, index) => (
                            <li key={index}>
                              <div className="ai-draft-reference-meta">
                                {ref.senderName && <span><b>Sender:</b> {ref.senderName}</span>}
                                {ref.leadName && <span><b>Lead:</b> {ref.leadName}</span>}
                                {ref.campaignName && <span><b>Campaign:</b> {ref.campaignName}</span>}
                              </div>
                              <p>{ref.body}</p>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {allDrafts.length > visible && (
            <button type="button" className="audit-see-more" onClick={() => setVisible((v) => v + 10)}>
              See 10 more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function AiHubView() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [audit, setAudit] = useState<AiAuditData | null>(null);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [promptSaved, setPromptSaved] = useState(false);
  const [promptError, setPromptError] = useState("");
  const [clientBrief, setClientBrief] = useState("");
  const [icpPrompt, setIcpPrompt] = useState("");
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [followUpThreshold, setFollowUpThreshold] = useState(50);
  const [replyPrompt, setReplyPrompt] = useState("");
  const [clientSaving, setClientSaving] = useState(false);
  const [clientSaved, setClientSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "prompts" | "clients">("overview");
  const [savedTemplates, setSavedTemplates] = useState<Array<{ id: string; kind: string; name: string; summary: string; prompt: string }>>([]);

  const loadSavedTemplates = () => fetch("/api/ai/templates", { cache: "no-store" })
    .then((r) => r.json())
    .then((payload) => setSavedTemplates(Array.isArray(payload?.templates) ? payload.templates : []))
    .catch(() => null);

  /** Returns an error message, or "" when the save landed. */
  const saveTemplate = async (kind: "icp" | "follow_up", name: string, prompt: string): Promise<string> => {
    const response = await fetch("/api/ai/templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, name, prompt }) }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    if (!response?.ok || !payload?.ok) return String(payload?.error ?? "Could not save the template.");
    await loadSavedTemplates();
    return "";
  };

  const deleteTemplate = async (id: string) => {
    // Optimistic, then reconciled from the server — a delete that failed would otherwise leave the
    // card gone from the page but still there for everyone else.
    setSavedTemplates((previous) => previous.filter((template) => template.id !== id));
    await fetch(`/api/ai/templates?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    await loadSavedTemplates();
  };

  const templatesFor = (kind: "icp" | "follow_up"): ScoringTemplate[] => [
    ...(kind === "icp" ? ICP_TEMPLATES : FOLLOW_UP_TEMPLATES),
    ...savedTemplates.filter((template) => template.kind === kind).map((template) => ({ id: template.id, name: template.name, summary: template.summary, prompt: template.prompt, saved: true })),
  ];

  const loadConfig = (workspace?: string) => {
    const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    fetch(`/api/ai/config${query}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: AiConfig) => {
        setConfig(payload);
        setGlobalPrompt(String(payload.globalSentimentPrompt ?? ""));
        if (payload.workspaceAi) {
          setClientBrief(payload.workspaceAi.brief);
          // A client with nothing stored is shown the same defaults the scoring routes fall back to,
          // so the page always displays the prompt the AI is actually running rather than a blank box
          // standing in for a default nobody can read.
          setIcpPrompt(payload.workspaceAi.icpPrompt || defaultIcpPrompt());
          setFollowUpPrompt(payload.workspaceAi.followUpPrompt || defaultFollowUpPrompt());
          setFollowUpThreshold(Number(payload.workspaceAi.followUpThreshold ?? 50));
          setReplyPrompt(payload.workspaceAi.replyPrompt);
        }
      })
      .catch(() => null);
  };

  useEffect(() => { loadConfig(); void loadSavedTemplates(); }, []);
  const [auditVisible, setAuditVisible] = useState(25);
  const [freshIds, setFreshIds] = useState<string[]>([]);
  const seenIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/ai/audit", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: AiAuditData) => {
        if (payload?.ok === false) return;
        setAudit(payload);
        const ids = (payload?.events ?? []).map((e) => String(e.id));
        if (seenIdsRef.current === null) { seenIdsRef.current = new Set(ids); return; }
        const seen = seenIdsRef.current;
        const added = ids.filter((id) => !seen.has(id));
        if (added.length) {
          added.forEach((id) => seen.add(id));
          setFreshIds(added);
          setTimeout(() => setFreshIds((cur) => cur.filter((id) => !added.includes(id))), 2000);
        }
      })
      .catch(() => null);
    load();
    const interval = setInterval(load, 3_000);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  useEffect(() => {
    if (selectedClient) loadConfig(selectedClient);
  }, [selectedClient]);

  /**
   * "Saved ✓" now means saved.
   *
   * This used to flash regardless of what came back, and the route it calls was writing to a table with
   * no `key` column — so the prompt failed to save every time and the button said it had worked. The
   * reason is shown instead of swallowed.
   */
  const saveGlobalPrompt = async () => {
    setPromptError("");
    const response = await fetch("/api/ai/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_sentiment_prompt", value: globalPrompt }),
    }).catch(() => null);
    const payload = (await response?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!payload?.ok) {
      setPromptError(payload?.error || "Could not save the prompt.");
      return;
    }
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 2500);
  };

  const saveClientAi = async () => {
    if (!selectedClient) return;
    setClientSaving(true);
    await fetch("/api/ai/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_workspace_ai", workspace: selectedClient, brief: clientBrief, icpPrompt, followUpPrompt, replyPrompt, followUpThreshold }),
    });
    setClientSaving(false);
    setClientSaved(true);
    setTimeout(() => setClientSaved(false), 2500);
  };

  const selectedWs = config?.workspaces?.find((ws) => ws.slug === selectedClient);
  // Judged on the live textarea rather than what is saved, so the panel unlocks as the brief is
  // typed instead of demanding a save round-trip first.
  const briefLength = clientBrief.trim().length;
  const icpLocked = briefLength < MIN_CLIENT_BRIEF_LENGTH;

  return <div className="ai-hub-view">
    <div className="admin-heading"><div>
      <h1 className="workspace-directory-page-title">AI</h1>
      <p>Anthropic configuration, sentiment analysis, and per-client AI context.</p>
    </div></div>

    <div className="ai-hub-tabs">
      <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>Overview</button>
      <button className={activeTab === "prompts" ? "active" : ""} onClick={() => setActiveTab("prompts")}>Prompts</button>
      <button className={activeTab === "clients" ? "active" : ""} onClick={() => setActiveTab("clients")}>Client AI context</button>
    </div>

    {activeTab === "overview" && <>
      <div className="admin-grid">
        <section className="admin-panel">
          <div className="panel-heading"><div><h2>Anthropic connection</h2><p>API heartbeat and configuration.</p></div>
            <span className={config?.anthropic?.configured ? "connection-badge" : "saved-dot"}><i /> {config?.anthropic?.configured ? "Connected" : "Not configured"}</span>
          </div>
          <label className="field-label">API KEY<div className="status-field">{config?.anthropic?.maskedKey ?? "Not set"}</div></label>
          <label className="field-label">MODEL<div className="status-field">{config?.anthropic?.model ?? "—"}</div></label>
          <div className="field-row">
            <label className="field-label">CURRENT FUNCTIONS<div className="status-field">Sentiment analysis · ICP scoring · Follow-up scoring · Reply drafts</div></label>
          </div>
        </section>
        <section className="admin-panel">
          <div className="panel-heading"><div><h2>Usage summary</h2><p>Token usage from Anthropic API calls.</p></div></div>
          <div className="ai-hub-kpis">
            <div className="ai-hub-kpi"><span>Total API calls</span><strong>{audit?.summary?.totalCalls ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Successful</span><strong>{audit?.summary?.successful ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Failed</span><strong>{audit?.summary?.failed ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Input tokens</span><strong>{audit?.summary?.totalInputTokens?.toLocaleString() ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Output tokens</span><strong>{audit?.summary?.totalOutputTokens?.toLocaleString() ?? "—"}</strong></div>
          </div>
        </section>
      </div>

      <DraftFeedPanel events={audit?.drafts ?? audit?.events ?? []} freshIds={freshIds} />

      <section className="admin-panel ai-audit-section">
        <div className="panel-heading"><div className="ai-audit-title"><h2 style={{ fontSize: 22 }}>AI audit log</h2><span className="ai-audit-live"><i />live</span></div>
          <button className="secondary-button" onClick={() => {
            if (!audit?.events?.length) return;
            const csv = ["When,Client,Lead,Action,Input Tokens,Output Tokens,Duration (ms),Status",
              ...audit.events.map((e) => `"${e.timestamp}","${e.workspaceName ?? ""}","${e.leadName ?? ""}","${e.action ?? ""}",${e.inputTokens},${e.outputTokens},${e.durationMs ?? ""},${e.status}`)
            ].join("\n");
            const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = `ai-audit-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
          }}>Export CSV ↓</button>
        </div>
        <div className="ai-audit-table ai-audit-compact">
          <div className="ai-audit-head"><span>When</span><span>Client</span><span>Lead</span><span>Action</span><span>Tokens</span><span>Duration</span><span>Status</span></div>
          {audit?.events?.length ? audit.events.slice(0, auditVisible).map((event) => {
            const d = event.timestamp ? new Date(event.timestamp) : null;
            const when = d && !isNaN(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}` : "—";
            const actionLabel: Record<string, string> = { "conversation.analyzed": "Sentiment + Reply", "draft.generated": "Suggested reply", "draft.failed": "Reply failed", "sentiment_analysis": "Sentiment analysis", "icp.scored": "ICP scoring", "followup.scored": "Follow-up score" };
            return <div className={`ai-audit-row${freshIds.includes(String(event.id)) ? " ai-audit-row-fresh" : ""}`} key={event.id}>
              <time>{when}</time>
              <span className="ai-audit-client-cell">{event.workspaceLogoUrl ? <img className="ai-audit-logo" src={event.workspaceLogoUrl} alt="" /> : null}{event.workspaceName || "—"}</span>
              <span className="ai-audit-lead-cell">{event.leadPhotoUrl ? <img className="ai-audit-avatar" src={event.leadPhotoUrl} alt="" /> : null}{event.leadName || "—"}</span>
              <span><strong>{actionLabel[event.action ?? ""] ?? event.action?.replaceAll(".", " ") ?? "—"}</strong></span>
              <span>{event.inputTokens || event.outputTokens ? `${event.inputTokens} in · ${event.outputTokens} out` : "—"}</span>
              <span>{event.durationMs ? `${event.durationMs}ms` : "—"}</span>
              <span className={`audit-status ${event.status === "success" ? "success" : event.status === "error" || event.status === "failed" ? "error" : "warning"}`}>{event.status}</span>
            </div>;
          }) : <p className="audit-empty">No AI audit events yet. Events will appear after the first reply is analyzed.</p>}
          {audit?.events && audit.events.length > auditVisible && <button className="audit-see-more" onClick={() => setAuditVisible((v) => v + 25)}>See 25 more</button>}
        </div>
      </section>
    </>}

    {activeTab === "prompts" && <>
      <section className="admin-panel">
        <div className="panel-heading"><div><h2>Sentiment analysis prompt</h2><p>This prompt is used to classify every inbound reply as positive, neutral, or negative. Edit it here to adjust how the AI categorizes replies.</p></div>
          <button className="primary-button" onClick={saveGlobalPrompt}>{promptSaved ? "Saved ✓" : "Save prompt"}</button>
        </div>
        <label className="field-label">GLOBAL SENTIMENT PROMPT
          <textarea value={globalPrompt} onChange={(event) => setGlobalPrompt(event.target.value)} rows={8} style={{ minHeight: 180 }} />
        </label>
        {promptError && <p className="form-error" role="alert">{promptError}</p>}
        <button className="text-button" onClick={() => setGlobalPrompt(config?.defaultSentimentPrompt ?? "")}>Reset to default prompt</button>
      </section>
    </>}

    {activeTab === "clients" && <>
      <div className="ai-client-layout">
        <aside className="ai-client-sidebar">
          <div className="admin-nav-caption">CLIENT AI CONTEXT</div>
          {config?.workspaces?.map((ws) => (
            <button key={ws.slug} className={`admin-nav-client-button ${selectedClient === ws.slug ? "active" : ""}`} onClick={() => setSelectedClient(ws.slug)}>
              <i style={ws.logoUrl ? undefined : { background: ws.accentColor || "var(--accent)" }}>{ws.logoUrl ? <img src={ws.logoUrl} alt="" /> : (ws.name?.[0] ?? "?")}</i>
              <span>{ws.name}</span>
              {ws.hasBrief && <b>●</b>}
            </button>
          ))}
        </aside>
        <div className="ai-client-content">
          {!selectedClient ? <div className="ai-client-empty"><p>Select a client to configure their AI context, ICP prompt, follow-up rules, and reply prompt.</p></div> : <>
            <div className="ai-client-header">
              <h2>{selectedWs?.logoUrl ? <img src={selectedWs.logoUrl} alt="" className="admin-client-heading-logo" /> : <span className="admin-client-heading-logo" style={{ background: selectedWs?.accentColor || "var(--accent)" }}>{selectedWs?.name?.[0] ?? "?"}</span>}{selectedWs?.name ?? selectedClient}</h2>
              <button className="primary-button" onClick={saveClientAi} disabled={clientSaving}>{clientSaving ? "Saving…" : clientSaved ? "Saved ✓" : "Save changes"}</button>
            </div>
            <div className="client-config-sections">
              <section className="admin-panel client-config-section">
                <div className="panel-heading"><div><h2>Client brief & documents</h2><p>Give the AI all the context about this client. This feeds into ICP scoring, follow-up scoring, and reply drafts.</p></div></div>
                <label className="field-label">CLIENT BRIEF<textarea value={clientBrief} onChange={(event) => setClientBrief(event.target.value)} placeholder="Tell the AI everything about this client: what they do, who their ideal customer is, their value proposition, competitive advantages, tone of voice, and any important context." rows={6} style={{ minHeight: 150 }} /></label>
                <button className="upload-zone" type="button"><span style={{ fontSize: 20 }}>＋</span><div><strong>Upload client documents</strong><small>PDF, DOCX, TXT · stored in Supabase Storage</small></div></button>
              </section>
              <section className={`admin-panel client-config-section${icpLocked ? " section-locked" : ""}`}>
                <div className="panel-heading"><div><h2>ICP scoring prompt</h2><p>How should the AI score this lead against the client&apos;s ideal customer profile?</p></div>
                  {icpLocked && <span className="locked-badge">🔒 Locked</span>}
                </div>
                {icpLocked
                  // ICP scoring is a judgement about fit, and fit is meaningless without knowing what
                  // the client sells and to whom. Scoring against an empty brief produces confident
                  // numbers derived from nothing, which is worse than no score at all.
                  ? <div className="locked-explainer">
                      <p>Fill in the <strong>client brief</strong> above first. ICP scoring judges how well a lead fits <em>this client</em>, so the AI needs to know what they sell and who they sell it to before any score means anything.</p>
                      <div className="locked-progress"><i style={{ width: `${Math.min(100, Math.round((briefLength / MIN_CLIENT_BRIEF_LENGTH) * 100))}%` }} /></div>
                      <small>{briefLength} of {MIN_CLIENT_BRIEF_LENGTH} characters written — {MIN_CLIENT_BRIEF_LENGTH - briefLength} to go.</small>
                    </div>
                  : <>
                      <TemplatePicker templates={templatesFor("icp")} value={icpPrompt} onPick={setIcpPrompt} onSave={(name) => saveTemplate("icp", name, icpPrompt)} onDelete={(id) => void deleteTemplate(id)} />
                      <label className="field-label">ICP PROMPT<textarea value={icpPrompt} onChange={(event) => setIcpPrompt(event.target.value)} placeholder="Describe what makes a lead a good fit for this client: the titles, seniority, company size, and industries that matter, and who to score down." rows={12} style={{ minHeight: 240 }} /></label>
                      <small className="threshold-hint">The client brief above is sent to the AI alongside this prompt on every score.</small>
                    </>}
              </section>
              <section className="admin-panel client-config-section">
                <div className="panel-heading"><div><h2>Follow-up scoring prompt</h2><p>How should the AI determine follow-up urgency?</p></div></div>
                <TemplatePicker templates={templatesFor("follow_up")} value={followUpPrompt} onPick={setFollowUpPrompt} onSave={(name) => saveTemplate("follow_up", name, followUpPrompt)} onDelete={(id) => void deleteTemplate(id)} />
                <label className="field-label">FOLLOW-UP PROMPT<textarea value={followUpPrompt} onChange={(event) => setFollowUpPrompt(event.target.value)} placeholder="Describe what should make a conversation urgent to follow up on, and what should keep it quiet." rows={12} style={{ minHeight: 240 }} /></label>
                <label className="field-label">FOLLOW-UP ALERT THRESHOLD<span className="threshold-row"><input type="range" min={0} max={100} step={5} value={followUpThreshold} onChange={(event) => setFollowUpThreshold(Number(event.target.value))} /><b>{followUpThreshold}</b></span><small className="threshold-hint">Only show the &ldquo;follow-up recommended&rdquo; box when a lead scores at or above this. Higher = less noise.</small></label>
              </section>
            </div>
          </>}
        </div>
      </div>
    </>}
  </div>;
}
