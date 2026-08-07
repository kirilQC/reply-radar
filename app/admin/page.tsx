"use client";
/* eslint-disable @next/next/no-html-link-for-pages, jsx-a11y/label-has-associated-control, react/no-unescaped-entities */

import { useEffect, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";

const clients = [
  {
    name: "Northstar AI",
    slug: "northstar",
    leads: 486,
    status: "Connected",
    tone: "#8b7cff",
    lastSync: "24 sec ago",
  },
  {
    name: "Pylon Labs",
    slug: "pylon",
    leads: 312,
    status: "Connected",
    tone: "#55c7a2",
    lastSync: "2 min ago",
  },
  {
    name: "Vectorly",
    slug: "vectorly",
    leads: 198,
    status: "Needs attention",
    tone: "#f2a36b",
    lastSync: "3 hr ago",
  },
];
type HeartbeatPayload = {
  status: string;
  services: Array<{ id: string; label: string; configured: boolean }>;
  clients: Array<{ name: string; slug: string; keyConfigured: boolean; webhookAgeSeconds: number | null; pollAgeSeconds: number | null; status: string }>;
};

export default function AdminPage() {
  const [active, setActive] = useState("workspaces");
  const [selected, setSelected] = useState(0);
  const [clientSearch, setClientSearch] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
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
  const client = clients[selected];
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
  const setAccentColor = (value: string) =>
    setAccentOverrides((current) => ({ ...current, [client.slug]: value }));
  const chooseLogo = () => logoInput.current?.click();
  const handleLogo = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || file.size > 2 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () =>
      setLogos((current) => ({
        ...current,
        [client.slug]: String(reader.result),
      }));
    reader.readAsDataURL(file);
  };
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <main
          className={`admin-shell admin-theme-${themePreset}`}
          style={(accentOverrides[client.slug] ? { "--accent": accentColor } : undefined) as unknown as React.CSSProperties}
        >
          <header className="admin-topbar">
            <a className="admin-brand" href="/">
              ←{" "}
              <span className="brand-mark">
                <i />
                <i />
                <i />
              </span>
              <strong>
                reply<span>radar</span>
              </strong>
            </a>
            <div className="admin-breadcrumb">
              Admin console <span>/</span>{" "}
              {active === "global"
                ? "Global config"
                : active === "workspaces"
                  ? "Client workspaces"
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
              <div className="admin-nav-caption">GLOBAL CONFIG</div>
              <button
                className={active === "global" ? "active" : ""}
                onClick={() => setActive("global")}
              >
                <span>◈</span>Global config
              </button>
              <div className="admin-nav-caption client-caption">CLIENTS</div>
              <div className="admin-client-list">
                {clients.map((item, index) => (
                  <div
                    className={`admin-client-group ${selected === index ? "selected" : ""}`}
                    key={item.slug}
                  >
                    <button
                      className="admin-client-button"
                      onClick={() => {
                        setSelected(index);
                        setActive("workspaces");
                        setWorkspaceOpen(true);
                      }}
                    >
                      <i style={{ background: item.tone }}>{item.name[0]}</i>
                      <span>{item.name}</span>
                    </button>
                  </div>
                ))}
              </div>
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
              <div className="admin-nav-bottom">
                <a href="/">← Back to inbox</a>
                <small>Reply Radar · Internal build</small>
              </div>
            </aside>
            <section className="admin-content">
              <div className="admin-heading">
                <div>
                  <div className="eyebrow">
                    <span className="live-dot" />
                    ADMIN CONSOLE
                  </div>
                  <h1>
                    {active === "workspaces" && workspaceOpen ? <><span className="admin-client-heading-logo" style={{ background: client.tone }}>{client.name[0]}</span>{client.name}</> : active === "global"
                      ? "Global config"
                      : active === "workspaces"
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
                  <p>
                    {active === "global"
                      ? "Shared runtime credentials and worker settings for Reply Radar."
                      : active === "workspaces"
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
                  </p>
                </div>
                {active !== "heartbeat" && active !== "audit" && <button
                  className="primary-button"
                  onClick={() => active === "workspaces" ? setWorkspaceOpen(true) : setSaved(true)}
                >
                  {saved
                    ? "Saved ✓"
                    : active === "workspaces"
                      ? "+ Add workspace"
                      : "Save changes"}
                </button>}
              </div>
              {active === "global" && (
                <div className="admin-grid">
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Provider credentials</h2>
                        <p>
                          Shared infrastructure keys. Client keys stay in each
                          client profile.
                        </p>
                      </div>
                      <span className="connection-badge">
                        <i /> Internal only
                      </span>
                    </div>
                    <label className="field-label">
                      ANTHROPIC API KEY
                      <div className="secret-field">
                        <input type="password" placeholder="sk-ant-..." />
                        <button type="button">Reveal</button>
                      </div>
                    </label>
                    <label className="field-label">
                      SUPABASE URL
                      <input placeholder="https://your-project.supabase.co" />
                    </label>
                    <label className="field-label">
                      SUPABASE SERVICE ROLE KEY
                      <div className="secret-field">
                        <input type="password" placeholder="service-role key" />
                        <button type="button">Reveal</button>
                      </div>
                    </label>
                  </section>
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Worker configuration</h2>
                        <p>
                          Queue, reconciliation, and watchdog runtime settings.
                        </p>
                      </div>
                    </div>
                    <label className="field-label">
                      WORKER SERVICE URL
                      <input placeholder="https://reply-radar-worker.onrender.com" />
                    </label>
                    <div className="field-row">
                      <label className="field-label">
                        POLL INTERVAL (SECONDS)
                        <input type="number" defaultValue="120" />
                      </label>
                      <label className="field-label">
                        MAX RETRIES
                        <input type="number" defaultValue="5" />
                      </label>
                    </div>
                    <label className="field-label">
                      QUEUE MODE
                      <select defaultValue="durable">
                        <option value="durable">Durable queue</option>
                        <option value="inline">Inline processing</option>
                      </select>
                    </label>
                  </section>
                </div>
              )}
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
                        <strong>{item.name}</strong>
                        <small>
                          {item.leads} leads · Last sync {item.lastSync}
                        </small>
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
                  {workspaceOpen && <div className="workspace-editor-toolbar"><button className="secondary-button" onClick={() => setWorkspaceOpen(false)}>← Back to directory</button></div>}
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
                        <span className="connection-badge">
                          <i /> API healthy
                        </span>
                      </div>
                      <label className="field-label">
                        WORKSPACE NAME
                        <input value={client.name} readOnly />
                      </label>
                      <label className="field-label">
                        HEYREACH API KEY
                        <div className="secret-field">
                          <input
                            type="text"
                            value={
                              showKey
                                ? "hr_live_northstar_••••••••••••3f8a"
                                : "hr_live_••••••••••••••••••••••••"
                            }
                            readOnly
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
                            <i /> Registered · 10 event types
                          </div>
                        </label>
                        <label className="field-label">
                          LAST RECONCILIATION
                          <div className="status-field">
                            Today, 09:42 AM <span>↻</span>
                          </div>
                        </label>
                      </div>
                      <div className="endpoint-box">
                        <div>
                          <small>WEBHOOK ENDPOINT</small>
                          <code>
                            replyradar.app/api/webhooks/heyreach/{client.slug}
                            /••••••••
                          </code>
                        </div>
                        <button>Copy</button>
                      </div>
                      <div className="panel-actions">
                        <button className="secondary-button">Rotate key</button>
                        <button className="secondary-button">
                          Run backfill
                        </button>
                        <button className="text-button">
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
                        <input defaultValue={client.name} />
                      </label>
                      <label className="field-label">
                        CLIENT BRIEF
                        <textarea defaultValue="Northstar helps modern revenue teams turn outbound signals into qualified pipeline. Their buyers are RevOps leaders at growing B2B companies." />
                      </label>
                      <div className="field-row">
                        <label className="field-label">
                          TIMEZONE
                          <select defaultValue="America/Chicago">
                            <option>America/Chicago</option>
                            <option>America/New_York</option>
                            <option>Europe/London</option>
                          </select>
                        </label>
                        <label className="field-label">
                          WORKSPACE SLUG
                          <input defaultValue={client.slug} />
                        </label>
                      </div>
                      <div className="upload-zone">
                        ＋{" "}
                        <div>
                          <strong>Drop client docs here</strong>
                          <small>
                            PDF, DOCX, TXT, MD · stored in Supabase Storage
                          </small>
                        </div>
                      </div>
                    </section>
                  </div>}
                  {workspaceOpen && <div className="client-config-sections">
                    <section className="admin-panel client-config-section" id="client-ai">
                      <div className="panel-heading"><div><h2>AI context & voice</h2><p>Client-specific Anthropic drafting rules and review guardrails.</p></div><span className="connection-badge"><i /> Client-specific</span></div>
                      <div className="field-row"><label className="field-label">MODEL<select defaultValue="claude-sonnet-4-20250514"><option>claude-sonnet-4-20250514</option><option>claude-3-7-sonnet-latest</option></select></label><label className="field-label">TEMPERATURE<input type="number" defaultValue="0.35" step="0.05" /></label></div>
                      <label className="field-label">CUSTOM SYSTEM PROMPT<textarea defaultValue="Be concise, specific, and human. Never invent customer proof. Ask one clear next-step question." /></label>
                    </section>
                    <section className="admin-panel client-config-section" id="client-scoring">
                      <div className="panel-heading"><div><h2>Scoring engine</h2><p>Client-specific queue weights and urgency thresholds.</p></div><span className="saved-dot">● Draft config</span></div>
                      <div className="field-row"><label className="field-label">HOT THRESHOLD<input type="number" defaultValue="80" /></label><label className="field-label">WARM THRESHOLD<input type="number" defaultValue="60" /></label></div>
                      <label className="field-label">UNANSWERED QUESTION WEIGHT<input type="range" defaultValue="78" /></label>
                    </section>
                    <section className="admin-panel client-config-section" id="client-theme">
                      <div className="panel-heading"><div><h2>Theme & logo</h2><p>Brand this client's workspace without changing other clients.</p></div><span className="saved-dot">● Auto-saved</span></div>
                      <div className="logo-drop"><div className="logo-sample" style={{ background: accentColor }}>{client.name[0]}</div><div><strong>Upload client logo</strong><small>SVG, PNG, JPG · max 2MB</small></div><button className="secondary-button" onClick={chooseLogo}>Choose file</button><input ref={logoInput} type="file" accept="image/png,image/jpeg,image/svg+xml" hidden onChange={handleLogo} /></div>
                      <label className="field-label">CLIENT ACCENT<input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} /></label>
                    </section>
                  </div>}
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
                      <select defaultValue="claude-sonnet-4-20250514">
                        <option>claude-sonnet-4-20250514</option>
                        <option>claude-3-7-sonnet-latest</option>
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
                        <input type="number" defaultValue="0.35" step="0.05" />
                      </label>
                      <label className="field-label">
                        MONTHLY SPEND CAP
                        <input defaultValue="$250" />
                      </label>
                    </div>
                    <div className="usage-meter">
                      <div>
                        <span>August usage</span>
                        <strong>$42.18 / $250</strong>
                      </div>
                      <div>
                        <i style={{ width: "17%" }} />
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
                      <textarea defaultValue="Be concise, specific, and human. Never invent customer proof. Ask one clear next-step question. Do not mention pricing before a call is booked." />
                    </label>
                    <label className="field-label">
                      BANNED PHRASES
                      <input defaultValue="just checking in, hope you're well, circle back" />
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
                    {[
                      ["Unanswered question", "+28"],
                      ["Reply depth", "+22"],
                      ["Meeting language", "+18"],
                      ["Response speed", "+12"],
                      ["Time decay", "−10"],
                    ].map(([name, value], i) => (
                      <div className="range-row" key={name}>
                        <div>
                          <span>{name}</span>
                          <strong>{value}</strong>
                        </div>
                        <input
                          type="range"
                          defaultValue={String(78 - i * 12)}
                        />
                      </div>
                    ))}
                    <div className="preview-score">
                      <span>Preview with current rules</span>
                      <strong>
                        Jordan Mendez <b>94 · hot</b>
                      </strong>
                      <small>
                        Asked for pricing 4 days ago, never answered
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
                      <input defaultValue="80" />
                      <small>Priority reply within 24 hours</small>
                    </div>
                    <div className="threshold warm-threshold">
                      <span>WARM</span>
                      <input defaultValue="60" />
                      <small>Follow up this week</small>
                    </div>
                    <div className="threshold nurture-threshold">
                      <span>NURTURE</span>
                      <input defaultValue="35" />
                      <small>Keep warm or snooze</small>
                    </div>
                    <div className="threshold dead-threshold">
                      <span>DEAD</span>
                      <input defaultValue="0" />
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
                        <select defaultValue="Compact">
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
                      {logos[client.slug] ? (
                        <img
                          className="logo-sample"
                          src={logos[client.slug]}
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
                      <button className="secondary-button" onClick={chooseLogo}>
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
    </div>
  );
}

function HeartbeatView({ heartbeat, onRefresh }: { heartbeat: HeartbeatPayload | null; onRefresh: () => void }) {
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
        <div><span className="eyebrow"><span className="live-dot" /> LIVE PULSE</span><h2>{heartbeat?.status === "live" ? "All checks completed" : heartbeat?.status === "not_configured" ? "Configuration required" : "Checking infrastructure…"}</h2><p>Checks run against the configured Supabase records and service settings.</p></div>
        <button className="secondary-button" onClick={onRefresh}>Refresh checks ↻</button>
      </div>
      <div className="heartbeat-service-grid">{(heartbeat?.services ?? [{ id: "supabase", label: "Supabase database", configured: false }, { id: "anthropic", label: "Anthropic API", configured: false }, { id: "worker", label: "Worker service", configured: false }]).map((service) => <div className="heartbeat-service admin-panel" key={service.id}><i className={service.configured ? "heartbeat-ok" : "heartbeat-missing"} /><div><strong>{service.label}</strong><small>{service.configured ? "Configured" : "Not configured"}</small></div></div>)}</div>
      <section className="admin-panel"><div className="panel-heading"><div><h2>Client connection heartbeat</h2><p>Webhook freshness, HeyReach key presence, and reconciliation freshness per client.</p></div></div><div className="heartbeat-client-list">{heartbeat?.clients?.length ? heartbeat.clients.map((item) => <div className="heartbeat-client-row" key={item.slug}><i style={{ background: clients.find((client) => client.slug === item.slug)?.tone ?? "#8b7cff" }}>{item.name[0]}</i><strong>{item.name}</strong><span className={item.status === "healthy" ? "health-state ready" : "health-state missing"}>{item.status === "healthy" ? "Healthy" : item.status === "missing" ? "Missing key" : "Needs attention"}</span><small>Key {item.keyConfigured ? "configured" : "missing"} · Webhook {item.webhookAgeSeconds === null ? "never received" : formatAge(item.webhookAgeSeconds)} · Poll {item.pollAgeSeconds === null ? "never run" : formatAge(item.pollAgeSeconds)}</small></div>) : <div className="heartbeat-empty">No synced client heartbeat data is available yet. Configure Supabase and run the HeyReach worker to begin checks.</div>}</div></section>
    </div>
  );
}

function AuditView() {
  const [now] = useState(() => Date.now());
  const events = [
    { timestamp: now, action: "heartbeat.check", actor: "System", detail: "Requested live credential, webhook, and sync freshness checks.", status: "started" },
    { timestamp: now - 61_000, action: "workspace.sync", actor: "Worker", detail: "Reconciled client conversations and refreshed webhook cursors.", status: "completed" },
    { timestamp: now - 121_000, action: "global.config.viewed", actor: "Admin", detail: "Opened provider credentials and worker configuration.", status: "recorded" },
    { timestamp: now - 181_000, action: "client.scoring.updated", actor: "Admin", detail: "Saved scoring weights and tier thresholds for Northstar AI.", status: "recorded" },
    { timestamp: now - 241_000, action: "webhook.event.received", actor: "HeyReach", detail: "Accepted a conversation.updated event from Pylon Labs.", status: "processed" },
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
