"use client";
/* eslint-disable @next/next/no-html-link-for-pages, jsx-a11y/label-has-associated-control, react/no-unescaped-entities, react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
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
              {active === "workspaces"
                ? <>Configuration {workspaceOpen && <><span>/</span> {client.name || "New workspace"}</>}</>
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
              <div className="admin-heading">
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
              </div>
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
    <div className="audit-table"><div className="audit-table-head"><span>When</span><span>Source</span><span>What happened</span><span>Status</span></div>{loading && !events.length ? <p className="audit-empty">Loading the live audit feed…</p> : events.map((event) => <article className={`audit-row ${event.severity}`} key={event.id}><time>{new Date(event.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</time><div className="audit-source">{event.workspaceLogo ? <img src={event.workspaceLogo} alt={`${event.workspace ?? "Client"} logo`} /> : <i />}<span><strong>{event.source}</strong>{event.workspace && <small>{event.workspace}</small>}</span></div><div className="audit-description"><strong>{event.action.replaceAll("_", " ").replaceAll(".", " · ")}</strong><p>{event.summary}</p><details><summary>Technical details</summary><pre>{JSON.stringify(event.details ?? {}, null, 2)}</pre></details></div><span className={`audit-status ${event.severity}`}>{event.status}</span></article>)}{!loading && !events.length && !error && <p className="audit-empty">No real events match these filters yet.</p>}{hasMore && <button className="audit-see-more" onClick={() => setVisibleCount((count) => count + pageSize)}>See 24 more events ↓</button>}</div>
  </section>;
}
