"use client";
/* eslint-disable @next/next/no-html-link-for-pages, jsx-a11y/label-has-associated-control, react/no-unescaped-entities, react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";

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
  webhookUrl?: string;
  apiKeyMasked?: string;
  guardrails?: Record<string, unknown>;
  aiArkEnrichmentEnabled?: boolean;
};

const initialClients: ClientWorkspace[] = [];
type HeartbeatPayload = {
  status: string;
  checkedAt?: string;
  services: Array<{ id: string; label: string; configured: boolean; explanation?: string }>;
  clients: Array<{ name: string; slug: string; keyConfigured: boolean; webhookAgeSeconds: number | null; pollAgeSeconds: number | null; status: string; webhookStatus?: string; pollStatus?: string; lastWebhookReceivedAt?: string | null; lastSuccessfulPollAt?: string | null; recentRuns?: unknown[]; recentEvents?: unknown[]; raw?: Record<string, unknown> }>;
  worker?: { status: string; recordedStatus?: unknown; ageSeconds: number | null; startedAt?: string; finishedAt?: string; durationSeconds?: number | null; workspacesSeen: number; recordsWritten?: unknown; source?: unknown; runType?: unknown; error: string | null; recentRuns?: unknown[]; raw?: Record<string, unknown> } | null;
  thresholds?: Record<string, number>;
  diagnostics?: Record<string, unknown>;
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
  const [aiArkConfigured, setAiArkConfigured] = useState(false);
  const [themePreset, setThemePreset] = useState("midnight");
  const [consoleAccent, setConsoleAccent] = useState("#f0cf00");
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [documents, setDocuments] = useState<Record<string, string[]>>({});
  const [accentOverrides, setAccentOverrides] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = window.localStorage.getItem("reply-radar-admin-accent-overrides");
      return stored ? (JSON.parse(stored) as Record<string, string>) : {};
    } catch { return {}; }
  });
  const logoInput = useRef<HTMLInputElement>(null);
  const docsInput = useRef<HTMLInputElement>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatPayload | null>(null);
  const [heartbeatRefresh, setHeartbeatRefresh] = useState(0);
  const clients = workspaceClients;
  const client = clients[Math.min(selected, Math.max(0, clients.length - 1))] ?? { name: "", slug: "", leads: 0, status: "Not configured", tone: "#8b7cff", lastSync: "not synced" };
  const [workspaceDraft, setWorkspaceDraft] = useState({ name: "", slug: "", brief: "", timezone: "America/New_York", website: "", anthropicModel: "", apiKey: "", aiArkEnrichmentEnabled: false });
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
          setAiArkConfigured(Boolean(payload.aiArkConfigured));
          setWorkspaceClients(payload.workspaces.map((item: Record<string, unknown>) => ({
            id: String(item.id ?? ""), name: String(item.name ?? ""), slug: String(item.slug ?? ""), leads: 0,
            status: item.last_successful_poll_at ? "Connected" : "Not configured", tone: String(item.accent_color ?? "var(--accent)"),
            lastSync: String(item.last_successful_poll_at ?? "not synced"), createdAt: String(item.created_at ?? ""),
            brief: String(item.client_brief ?? ""), apiKey: "", apiKeyMasked: String(item.heyreach_api_key_masked ?? ""), timezone: String(item.timezone ?? "America/New_York"), website: String(item.website_url ?? ""), anthropicModel: String(item.anthropic_model ?? ""), webhookUrl: String(item.webhook_url ?? ""), keyConfigured: Boolean(item.key_configured),
            logoUrl: String(item.logo_url ?? ""),
            guardrails: item.guardrails && typeof item.guardrails === "object" ? item.guardrails as Record<string, unknown> : {}, aiArkEnrichmentEnabled: Boolean(item.ai_ark_enrichment_enabled),
          })));
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
    try {
      const saved = window.localStorage.getItem("reply-radar-prefs:general");
      if (saved) {
        const parsed = JSON.parse(saved) as { appearance?: { accent?: string } };
        if (parsed.appearance?.accent) setConsoleAccent(parsed.appearance.accent);
      }
    } catch { /* keep console default */ }
  }, []);
  useEffect(() => {
    if (!workspaceOpen || !client) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */ setWorkspaceDraft({ name: client.name, slug: client.slug, brief: client.brief ?? "", timezone: client.timezone ?? "America/New_York", website: client.website ?? "", anthropicModel: client.anthropicModel ?? "", apiKey: "", aiArkEnrichmentEnabled: Boolean(client.aiArkEnrichmentEnabled) });
  }, [selected, workspaceOpen]);
  const addWorkspace = () => {
    const next: ClientWorkspace = { name: "", slug: `workspace-${Date.now()}`, leads: 0, status: "Not configured", tone: "#8b7cff", lastSync: "not synced", createdAt: new Date().toISOString(), isNew: true };
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
    const response = await fetch("/api/admin/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: client.id, previousSlug: client.slug, name: normalizedName, slug: normalizedSlug, clientBrief: workspaceDraft.brief, timezone: workspaceDraft.timezone || "America/New_York", websiteUrl: workspaceDraft.website, anthropicModel: workspaceDraft.anthropicModel || null, ...(workspaceDraft.apiKey.trim() ? { heyreachApiKey: workspaceDraft.apiKey.trim() } : {}), logoUrl, accentColor: accentOverrides[client.slug] ?? client.tone, guardrails: client.guardrails ?? {}, aiArkEnrichmentEnabled: workspaceDraft.aiArkEnrichmentEnabled }) }).catch(() => null);
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
    const next = workspaceClients.map((item, index) => index === selected ? { ...item, id: String(savedRow?.id ?? item.id ?? ""), name: normalizedName, slug: normalizedSlug, brief: workspaceDraft.brief, apiKey: "", apiKeyMasked: savedRow?.heyreach_api_key_masked ?? (workspaceDraft.apiKey.trim() ? `Saved key ••••${workspaceDraft.apiKey.trim().slice(-4)}` : item.apiKeyMasked), keyConfigured: savedRow?.key_configured ?? keyWasSaved, timezone: workspaceDraft.timezone, website: workspaceDraft.website, anthropicModel: workspaceDraft.anthropicModel, tone: accentOverrides[client.slug] ?? item.tone, logoUrl, guardrails: { ...(item.guardrails ?? {}), ai_ark_enrichment_enabled: workspaceDraft.aiArkEnrichmentEnabled }, aiArkEnrichmentEnabled: workspaceDraft.aiArkEnrichmentEnabled, isNew: false } : item);
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
  const visibleClients = clients.filter((item) => item.name.toLowerCase().includes(clientSearch.toLowerCase()) || item.slug.includes(clientSearch.toLowerCase()));
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
  const handleDocuments = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setDocuments((current) => ({
      ...current,
      [client.slug]: [...(current[client.slug] ?? []), ...files.map((file) => file.name)],
    }));
    event.target.value = "";
  };
  const copyWebhook = () => {
    void navigator.clipboard?.writeText(client.webhookUrl || `https://reply-radar-mauve.vercel.app/api/webhooks/heyreach/${client.slug}`);
    showSavedConfirmation();
  };
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <main
          className={`admin-shell admin-theme-${themePreset}`}
          style={{ "--accent": consoleAccent } as unknown as React.CSSProperties}
        >
          <header className="admin-topbar">
            <a className="admin-brand admin-back-link" href="/" aria-label="Back to dashboard">←</a>
            <div className="admin-breadcrumb">
              Admin Console <span>/</span>{" "}
              {active === "workspaces"
                ? <>Client Directory {workspaceOpen && <><span>/</span> {client.name || "New workspace"}</>}</>
                : active === "ai"
                    ? "AI context"
                    : active === "scoring"
                      ? "Scoring engine"
                      : active === "heartbeat"
                        ? "Heartbeat"
                        : active === "audit"
                          ? "Audit log"
                      : "Theme studio"}
            </div>
            <div className="admin-top-actions">
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
              <div className="admin-nav-caption system-caption">SYSTEM</div>
              {[
                ["heartbeat", "Heartbeat", "⌁"],
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
            <section className="admin-content">
              <div className="admin-heading">
                <div>
                  <div className="eyebrow">
                    <span className="live-dot" />
                    ADMIN CONSOLE
                  </div>
                  <h1 className={active === "workspaces" && workspaceOpen ? "client-config-heading" : undefined}>
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
                                : active === "audit"
                                  ? "Audit log"
                                  : "System health"}
                  </h1>
                  {!(active === "workspaces" && workspaceOpen) && <p>
                    {active === "workspaces"
                        ? "Manage each client's HeyReach connection, context, and isolation."
                        : active === "ai"
                          ? "Tune the Anthropic drafting context for every client."
                          : active === "scoring"
                            ? "Make follow-up urgency explainable and client-specific."
                            : active === "heartbeat"
                              ? "Live pulse checks for credentials, webhooks, and sync freshness."
                              : active === "audit"
                                ? "A chronological record of configuration and ingestion events."
                            : active === "theme"
                              ? "Customize the interface without touching code."
                              : "Verify ingestion and worker reliability across every workspace."}
                  </p>}
                </div>
                {active === "workspaces" && <button
                  className="primary-button"
                  onClick={() => workspaceOpen ? saveWorkspaceChanges() : addWorkspace()}
                  disabled={saving}
                >
                  {saving
                    ? "Saving…"
                    : saved
                    ? "Saved ✓"
                    : workspaceOpen ? "Save changes" : "+ Add workspace"}
                </button>}
              </div>
              {workspaceError && active === "workspaces" && <p className="form-error" role="alert">{workspaceError}</p>}
              {active === "heartbeat" && <HeartbeatView heartbeat={heartbeat} onRefresh={() => { setHeartbeat(null); setHeartbeatRefresh((value) => value + 1); }} />}
              {active === "audit" && <AuditView />}
              {active === "workspaces" && (
                <>
                  {!workspaceOpen && <div className="workspace-directory">
                    <div className="workspace-directory-heading">
                      <div><strong>Client directory</strong><small>{clients.length} workspaces · Search and select a client to configure</small></div>
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
                        <div className="workspace-card-top">
                          <span
                            className={
                              item.status === "Connected" ? "ok" : "warn"
                            }
                          >
                            {item.status}
                          </span>
                        </div>
                        <strong>{item.name || "Unnamed workspace"}</strong>
                        <small>{item.leads} leads</small>
                        <div className="workspace-progress">
                          <span
                            style={{
                              width: `${65 + index * 11}%`,
                              background: item.tone,
                            }}
                          />
                        </div>
                      </button>
                    ); })}
                    {!visibleClients.length && <div className="workspace-directory-empty">No clients match your search.</div>}
                    </div>
                  </div>}
                  {workspaceOpen && <div className="workspace-editor-toolbar"><button className="secondary-button" onClick={() => setWorkspaceOpen(false)}>← Back to directory</button><button className="secondary-button" onClick={requestRemoveWorkspace}>Remove workspace</button></div>}
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
                            <option value="America/New_York">Eastern Time — America/New_York (default)</option>
                            <option value="America/Chicago">Central Time — America/Chicago</option>
                            <option value="Europe/London">London — Europe/London</option>
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
                      <button className="upload-zone" type="button" onClick={() => docsInput.current?.click()}>
                        ＋{" "}
                        <div>
                          <strong>Drop client docs here</strong>
                          <small>
                            {documents[client.slug]?.length
                              ? `${documents[client.slug].length} file${documents[client.slug].length === 1 ? "" : "s"} selected`
                              : "PDF, DOCX, TXT, MD · stored in Supabase Storage"}
                          </small>
                        </div>
                      </button>
                      <input ref={docsInput} type="file" accept=".pdf,.doc,.docx,.txt,.md" multiple hidden onChange={handleDocuments} />
                    </section>
                  </div>}
                    {workspaceOpen && <div className="client-config-sections">
                    <section className="admin-panel client-config-section" id="client-ai">
                      <div className="panel-heading"><div><h2>AI context & voice</h2><p>Client-specific Anthropic drafting rules and review guardrails.</p></div><span className="connection-badge"><i /> Client-specific</span></div>
                      <div className="field-row"><label className="field-label">MODEL<select value={workspaceDraft.anthropicModel} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, anthropicModel: event.target.value }))}><option value="">Select model</option><option>claude-opus-4-1-20250805</option><option>claude-opus-4-20250514</option><option>claude-sonnet-4-20250514</option><option>claude-3-7-sonnet-latest</option><option>claude-3-5-haiku-latest</option></select></label><label className="field-label">TEMPERATURE<input type="number" placeholder="Set temperature (0–1)" min="0" max="1" step="0.05" /><small>Lower values are more consistent; higher values are more varied.</small></label></div>
                      <label className="field-label">CUSTOM SYSTEM PROMPT<textarea placeholder="Add client-specific drafting rules" /></label>
                      <div className="logo-drop">
                        <div><strong>AI Ark lead enrichment</strong><small>{aiArkConfigured ? "API key is configured. New leads are enriched once, then served from Supabase." : "Add AI_ARK_API_KEY in Vercel before turning this on."}</small></div>
                        <button className={workspaceDraft.aiArkEnrichmentEnabled ? "primary-button" : "secondary-button"} type="button" aria-pressed={workspaceDraft.aiArkEnrichmentEnabled} disabled={!aiArkConfigured && !workspaceDraft.aiArkEnrichmentEnabled} onClick={() => setWorkspaceDraft((draft) => ({ ...draft, aiArkEnrichmentEnabled: !draft.aiArkEnrichmentEnabled }))}>{workspaceDraft.aiArkEnrichmentEnabled ? "Enrichment on" : "Enrichment off"}</button>
                      </div>
                    </section>
                    <section className="admin-panel client-config-section" id="client-scoring">
                      <div className="panel-heading"><div><h2>Scoring engine</h2><p>Client-specific queue weights and urgency thresholds.</p></div><span className="saved-dot">● Draft config</span></div>
                      <div className="field-row"><label className="field-label">HOT THRESHOLD<input type="number" placeholder="Set hot threshold" /></label><label className="field-label">WARM THRESHOLD<input type="number" placeholder="Set warm threshold" /></label></div>
                      <label className="field-label">UNANSWERED QUESTION WEIGHT<input type="range" defaultValue="0" /></label>
                    </section>
                    <section className="admin-panel client-config-section" id="client-theme">
                      <div className="panel-heading"><div><h2>Theme & logo</h2><p>Brand this client's workspace without changing other clients.</p></div><span className="saved-dot">● Auto-saved</span></div>
                      <div className="logo-drop">{workspaceLogo ? <img className="logo-sample" src={workspaceLogo} alt={`${client.name} logo`} /> : <div className="logo-sample" style={{ background: accentColor }}>{client.name[0] || "?"}</div>}<div><strong>Upload client logo</strong><small>SVG, PNG, JPG · max 2MB</small></div><button className="secondary-button" type="button" onClick={chooseLogo}>Choose file</button><input ref={logoInput} type="file" accept="image/png,image/jpeg,image/svg+xml" hidden onChange={handleLogo} /></div>
                      <label className="field-label">CLIENT ACCENT<input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} /></label>
                    </section>
                  </div>}
                  {workspaceOpen && <div className="workspace-created-meta">Created {client.createdAt ? new Date(client.createdAt).toLocaleDateString() : "—"}</div>}
                </>
              )}
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
                        <option>claude-opus-4-20250514</option>
                        <option>claude-sonnet-4-20250514</option>
                        <option>claude-3-7-sonnet-latest</option>
                        <option>claude-3-5-haiku-latest</option>
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
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Voice guardrails</h2>
                        <p>
                          Rules applied before any draft reaches an operator.
                        </p>
                      </div>
                    </div>
                    <label className="field-label">
                      CUSTOM SYSTEM PROMPT
                      <textarea placeholder="Add voice and review guardrails" />
                    </label>
                    <label className="field-label">
                      BANNED PHRASES
                      <input placeholder="Add banned phrases" />
                    </label>
                    <div className="toggle-row">
                      <span>
                        <strong>Use approved replies as examples</strong>
                        <small>
                          Retrieve similar wins from this client's corpus
                        </small>
                      </span>
                      <i className="toggle on" />
                    </div>
                    <div className="toggle-row">
                      <span>
                        <strong>Require human review</strong>
                        <small>Never send an AI draft automatically</small>
                      </span>
                      <i className="toggle on" />
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
      <section className="admin-panel"><div className="panel-heading"><div><h2>Client connection heartbeat</h2><p>Each client needs three things: a key, incoming webhook replies, and a recent background poll.</p></div></div><div className="heartbeat-client-list">{heartbeat?.clients?.length ? heartbeat.clients.map((item) => <div className="heartbeat-client" key={item.slug}><div className="heartbeat-client-title"><div className="heartbeat-client-name"><i style={{ background: "var(--accent)" }}>{item.name[0]}</i><strong>{item.name}</strong></div><span className={item.status === "healthy" ? "health-state ready" : "health-state missing"}>{item.status === "healthy" ? "Everything works" : item.status === "missing" ? "API key missing" : "Needs attention"}</span></div><div className="heartbeat-kid-grid"><div><b>{item.keyConfigured ? "✓" : "!"}</b><span><strong>Door key</strong><small>{item.keyConfigured ? "Reply Radar can ask HeyReach for updates." : "Add this client’s HeyReach key."}</small></span></div><div><b>{item.webhookAgeSeconds !== null ? "✓" : "!"}</b><span><strong>Incoming replies</strong><small>{item.webhookStatus ?? "No webhook information."}</small></span></div><div><b>{item.pollAgeSeconds !== null ? "✓" : "!"}</b><span><strong>Background check</strong><small>{item.pollStatus ?? "No poll information."}</small></span></div></div>{detail === "advanced" && <details className="diagnostic-details"><summary>Full client timestamps, recent runs, webhook events, and sanitized database row</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>}</div>) : <div className="heartbeat-empty">No clients were found. Add a client and start the Render worker to begin checks.</div>}</div></section>
      {detail === "advanced" && <section className="admin-panel"><div className="panel-heading"><div><h2>Full diagnostic payload</h2><p>Runtime flags, freshness thresholds, query status codes, timings, row counts, recent sync runs, and webhook events. Secrets are never included.</p></div></div><details className="diagnostic-details" open><summary>Raw heartbeat JSON</summary><pre>{JSON.stringify(heartbeat, null, 2)}</pre></details></section>}
      <p className="heartbeat-last-checked">Last checked {heartbeat?.checkedAt ? new Date(heartbeat.checkedAt).toLocaleString() : "not yet"}</p>
    </div>
  );
}

function AuditView() {
  const [now] = useState(() => Date.now());
  const events = [
    { timestamp: now, action: "heartbeat.check", actor: "System", detail: "Requested live credential, webhook, and sync freshness checks.", status: "started" },
    { timestamp: now - 61_000, action: "workspace.sync", actor: "Worker", detail: "Reconciled client conversations and refreshed webhook cursors.", status: "completed" },
    { timestamp: now - 121_000, action: "global.config.viewed", actor: "Admin", detail: "Opened provider credentials and worker configuration.", status: "recorded" },
    { timestamp: now - 181_000, action: "client.scoring.updated", actor: "Admin", detail: "Saved client scoring weights and tier thresholds.", status: "recorded" },
    { timestamp: now - 241_000, action: "webhook.event.received", actor: "HeyReach", detail: "Accepted a conversation.updated event.", status: "processed" },
    { timestamp: now - 301_000, action: "ai.draft.generated", actor: "Anthropic", detail: "Generated a human-review draft for a priority conversation.", status: "completed" },
    { timestamp: now - 361_000, action: "layout.saved", actor: "Admin", detail: "Saved inbox section order and six selected summary metrics.", status: "recorded" },
    { timestamp: now - 421_000, action: "profile.appearance.saved", actor: "User", detail: "Updated font, zoom, background, and accent preferences.", status: "recorded" },
  ];
  const exportAudit = () => {
    const csv = ["Timestamp,Actor,Action,Detail,Status", ...events.map((event) => [new Date(event.timestamp).toISOString(), event.actor, event.action, event.detail, event.status].map((value) => `"${value.replaceAll('"', '""')}"`).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `reply-radar-audit-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="admin-panel audit-view"><div className="panel-heading"><div><h2>Audit log</h2><p>Detailed configuration, ingestion, and infrastructure events.</p></div><button className="secondary-button" onClick={exportAudit}>Export CSV ↓</button></div>{events.map((event) => <div className="audit-row" key={`${event.timestamp}-${event.action}`}><time>{new Date(event.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</time><div><strong>{event.action}</strong><small>{event.actor} · {event.detail}</small></div><span>{event.status}</span></div>)}</section>;
}
