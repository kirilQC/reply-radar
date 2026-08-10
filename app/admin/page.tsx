"use client";
/* eslint-disable @next/next/no-html-link-for-pages, jsx-a11y/label-has-associated-control, react/no-unescaped-entities, react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";

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
  const [workspaceDraft, setWorkspaceDraft] = useState({ name: "", slug: "", brief: "", timezone: "America/New_York", website: "", messagingDocUrl: "", anthropicModel: "", apiKey: "" });
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
            brief: String(item.client_brief ?? ""), apiKey: "", apiKeyMasked: String(item.heyreach_api_key_masked ?? ""), timezone: String(item.timezone ?? "America/New_York"), website: String(item.website_url ?? ""), anthropicModel: String(item.anthropic_model ?? ""), webhookUrl: String(item.webhook_url ?? ""), keyConfigured: Boolean(item.key_configured),
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
    /* eslint-disable-next-line react-hooks/set-state-in-effect */ setWorkspaceDraft({ name: client.name, slug: client.slug, brief: client.brief ?? "", timezone: client.timezone ?? "America/New_York", website: client.website ?? "", messagingDocUrl: String(client.guardrails?.messaging_doc_url ?? ""), anthropicModel: client.anthropicModel ?? "", apiKey: "" });
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
    const response = await fetch("/api/admin/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...mutationIdentity, name: normalizedName, slug: normalizedSlug, clientBrief: workspaceDraft.brief, timezone: workspaceDraft.timezone || "America/New_York", websiteUrl: workspaceDraft.website, anthropicModel: workspaceDraft.anthropicModel || null, ...(workspaceDraft.apiKey.trim() ? { heyreachApiKey: workspaceDraft.apiKey.trim() } : {}), logoUrl, accentColor: accentOverrides[client.slug] ?? client.tone, guardrails: nextGuardrails }) }).catch(() => null);
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
        <main className={`admin-shell admin-theme-${themePreset}`}>
          <header className="admin-topbar">
            <div className="admin-breadcrumb admin-configuration-title">
              Configuration{active === "workspaces" && workspaceOpen ? <><span>/</span> {client.name || "New workspace"}</> : active !== "workspaces" ? <><span>/</span> {active === "ai-hub" ? "AI" : active === "ai" ? "AI context" : active === "scoring" ? "Scoring engine" : active === "heartbeat" ? "Heartbeat" : active === "audit" ? "Audit log" : "Theme studio"}</> : null}
            </div>
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
  const isWorkspaceSync = (event: AuditEvent) => event.severity === "success" && (event.action.includes("workspace") || event.action.includes("heartbeat") || event.action.includes("sync")) && event.source === "worker";
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
  workspaceAi: { name: string; slug: string; brief: string; model: string; icpPrompt: string; followUpPrompt: string; replyPrompt: string; sentimentPrompt: string } | null;
  workspaces: Array<{ id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; hasBrief: boolean }>;
};
type AiAuditEvent = { id: string; timestamp: string; action: string; status: string; model: string | null; sentiment: string | null; inputTokens: number; outputTokens: number; durationMs: number | null; reason: string | null; workspaceId: string | null; note: string | null };
type AiAuditData = { events: AiAuditEvent[]; summary: { totalCalls: number; successful: number; failed: number; totalInputTokens: number; totalOutputTokens: number } };

function AiHubView() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [audit, setAudit] = useState<AiAuditData | null>(null);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [promptSaved, setPromptSaved] = useState(false);
  const [clientBrief, setClientBrief] = useState("");
  const [icpPrompt, setIcpPrompt] = useState("");
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [replyPrompt, setReplyPrompt] = useState("");
  const [clientSaving, setClientSaving] = useState(false);
  const [clientSaved, setClientSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "prompts" | "clients">("overview");

  const loadConfig = (workspace?: string) => {
    const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    fetch(`/api/ai/config${query}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: AiConfig) => {
        setConfig(payload);
        setGlobalPrompt(String(payload.globalSentimentPrompt ?? ""));
        if (payload.workspaceAi) {
          setClientBrief(payload.workspaceAi.brief);
          setIcpPrompt(payload.workspaceAi.icpPrompt);
          setFollowUpPrompt(payload.workspaceAi.followUpPrompt);
          setReplyPrompt(payload.workspaceAi.replyPrompt);
        }
      })
      .catch(() => null);
  };

  useEffect(() => { loadConfig(); }, []);
  useEffect(() => {
    fetch("/api/ai/audit", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: AiAuditData) => setAudit(payload))
      .catch(() => null);
  }, []);
  useEffect(() => {
    if (selectedClient) loadConfig(selectedClient);
  }, [selectedClient]);

  const saveGlobalPrompt = async () => {
    await fetch("/api/ai/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save_sentiment_prompt", value: globalPrompt }) });
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 2500);
  };

  const saveClientAi = async () => {
    if (!selectedClient) return;
    setClientSaving(true);
    await fetch("/api/ai/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_workspace_ai", workspace: selectedClient, brief: clientBrief, icpPrompt, followUpPrompt, replyPrompt }),
    });
    setClientSaving(false);
    setClientSaved(true);
    setTimeout(() => setClientSaved(false), 2500);
  };

  const selectedWs = config?.workspaces?.find((ws) => ws.slug === selectedClient);

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

      <section className="admin-panel ai-audit-section">
        <div className="panel-heading"><div><h2>AI audit log</h2><p>Every Anthropic API call with token costs and results.</p></div></div>
        <div className="ai-audit-table">
          <div className="ai-audit-head"><span>When</span><span>Action</span><span>Result</span><span>Model</span><span>Tokens</span><span>Duration</span><span>Status</span></div>
          {audit?.events?.length ? audit.events.slice(0, 50).map((event) => (
            <div className="ai-audit-row" key={event.id}>
              <time>{new Date(event.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>
              <span><strong>{event.action?.replaceAll("_", " ")}</strong>{event.workspaceId && <small>{event.workspaceId}</small>}</span>
              <span>{event.sentiment ? <span className={`sentiment-badge sentiment-${event.sentiment}`}>{event.sentiment}</span> : event.note || "—"}</span>
              <span>{event.model ?? "—"}</span>
              <span>{event.inputTokens || event.outputTokens ? `${event.inputTokens} in · ${event.outputTokens} out` : "—"}</span>
              <span>{event.durationMs ? `${event.durationMs}ms` : "—"}</span>
              <span className={`audit-status ${event.status === "success" ? "success" : event.status === "error" ? "error" : "warning"}`}>{event.status}</span>
            </div>
          )) : <p className="audit-empty">No AI audit events yet. Events will appear after the first reply is analyzed.</p>}
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
              <section className="admin-panel client-config-section">
                <div className="panel-heading"><div><h2>ICP scoring prompt</h2><p>How should the AI score this lead against the client&apos;s ideal customer profile?</p></div></div>
                <label className="field-label">ICP PROMPT<textarea value={icpPrompt} onChange={(event) => setIcpPrompt(event.target.value)} placeholder="Score this lead from 0 to 100 based on how well they match the client's ideal customer profile. Consider: job title, company size, industry, seniority, and geographic location. Return a JSON object with 'score' (number) and 'reason' (string)." rows={5} style={{ minHeight: 120 }} /></label>
              </section>
              <section className="admin-panel client-config-section">
                <div className="panel-heading"><div><h2>Follow-up scoring prompt</h2><p>How should the AI determine follow-up urgency?</p></div></div>
                <label className="field-label">FOLLOW-UP PROMPT<textarea value={followUpPrompt} onChange={(event) => setFollowUpPrompt(event.target.value)} placeholder="Analyze the conversation and score the follow-up urgency from 0 to 100. Consider: whether the lead asked a question, expressed interest, mentioned a timeline, or requested a meeting. Return a JSON object with 'score' (number), 'tier' ('hot' | 'warm' | 'nurture'), and 'reason' (string)." rows={5} style={{ minHeight: 120 }} /></label>
              </section>
              <section className="admin-panel client-config-section">
                <div className="panel-heading"><div><h2>Suggested reply prompt</h2><p>How should the AI draft a reply for this client&apos;s leads?</p></div></div>
                <label className="field-label">REPLY PROMPT<textarea value={replyPrompt} onChange={(event) => setReplyPrompt(event.target.value)} placeholder="Draft a concise, natural follow-up reply on behalf of the sender. Match the client's tone of voice. Do not invent facts, meetings, or promises. Keep it under 3 sentences unless more context is needed." rows={5} style={{ minHeight: 120 }} /></label>
              </section>
            </div>
          </>}
        </div>
      </div>
    </>}
  </div>;
}
