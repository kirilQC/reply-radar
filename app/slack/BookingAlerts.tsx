// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useState } from "react";

/**
 * Booked meetings on the Slack tab: the shared setup (QC's Calendly, the Clay table) and, per client, the
 * event filter, the bookings channel, the steps and the switch. The pipeline is app/lib/booking-run.ts.
 */
type Step = { id: string; type: string; enabled: boolean; url?: string; label?: string; stage?: string; pipeline?: string; owner?: string; campaignProperty?: string };
type Client = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string;
  tone: string;
  enabled: boolean;
  enabledAt: string | null;
  eventFilter: string;
  channel: string;
  botName: string;
  steps: Step[];
  hubspotConnected: boolean;
  eventTypes: Array<{ id: string; name: string; source: string }>;
  ownCalendly: { email: string; scope: string } | null;
  ownCalCom: { email: string } | null;
  lastBooking: { name: string; at: string; stage: string; error: string } | null;
  briefAbout: string;
  briefInstructions: string;
  clientBrief: string;
  recent: Array<{ id: string; name: string; company: string; at: string; stage: string; error: string; clay: boolean; clayTimedOut: boolean }>;
};
type Brief = { leadSummary?: string; companySummary?: string; callFocus?: string; painPoints?: string };
type Global = {
  clayWebhookUrl: string;
  clayAuthSet: boolean;
  clayWaitMinutes: number;
  callbackUrl: string;
  calendly: { email: string; name: string; scope: string; connectedAt: string; auth: string } | null;
  calendlyOAuth: { clientIdSet: boolean; secretSet: boolean; redirectUri: string };
  calcom: { email: string; connectedAt: string } | null;
  lastClayCallback: { at: string; meeting_id: string; test: boolean; fields: string[] } | null;
};
type Payload = { ok: boolean; error?: string; global: Global; clients: Client[]; testChannelSet: boolean; defaultBriefInstructions: string };

const day = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : "";
const ago = (value: string) => {
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return day(value);
};
type CalendarEvent = { source: "calendly" | "calcom"; id: string; name: string; slug: string; active: boolean; owner: string; url: string };
const STAGE: Record<string, string> = { new: "received", enriching: "waiting on Clay", ready: "posting", done: "posted", failed: "failed", skipped: "skipped" };

async function call(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  return { ok: Boolean(response?.ok && payload?.ok !== false), payload, error: String(payload?.error || (response ? `Failed (${response.status}).` : "Network error.")) };
}

/**
 * `focus` (a client slug) is the per-client page opened from onboarding: that client only, opened up, with
 * its pre-call brief and recent bookings. Without it, every client, from the Slack tab.
 */
export default function BookingAlerts({ onBack, backLabel = "← Slack automations", focus = "" }: { onBack: () => void; backLabel?: string; focus?: string }) {
  const settingsPath = focus ? `/api/bookings/settings?client=${encodeURIComponent(focus)}` : "/api/bookings/settings";
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ brief: Brief; who: string } | null>(null);
  const [setupOpen, setSetupOpen] = useState(!focus);
  // Each client's own event types, loaded when its row is opened: one client's Calendly is one client's events.
  const [events, setEvents] = useState<Record<string, { list: CalendarEvent[]; errors: string[]; loading: boolean }>>({});
  const returnPath = focus ? `/bookings/${focus}` : "/slack?view=bookings";

  const take = (payload: Payload | null) => {
    if (payload?.global) {
      setData(payload);
      setError("");
    }
  };
  const load = async () => {
    const result = await call(settingsPath);
    if (result.ok) take(result.payload);
    else setError(result.error);
  };
  useEffect(() => { void load(); }, [settingsPath]);
  // Back from Calendly's sign-in: say how it went, then drop the flag from the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("calendly");
    if (!status) return;
    note("calendly", status === "connected" ? "Connected" : status);
    params.delete("calendly");
    window.history.replaceState(null, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}`);
  }, []);
  const loadEvents = async (workspaceId: string) => {
    setEvents((current) => ({ ...current, [workspaceId]: { list: current[workspaceId]?.list ?? [], errors: [], loading: true } }));
    const result = await call(`/api/bookings/events?workspaceId=${encodeURIComponent(workspaceId)}`);
    setEvents((current) => ({ ...current, [workspaceId]: { list: result.ok ? result.payload.events : [], errors: result.ok ? result.payload.errors : [result.error], loading: false } }));
  };
  const openClient = data?.clients.find((client) => client.id === open);
  const openCalendar = openClient ? `${openClient.ownCalendly?.email ?? ""}|${openClient.ownCalCom?.email ?? ""}` : "";
  useEffect(() => {
    if (openClient && (openClient.ownCalendly || openClient.ownCalCom)) void loadEvents(openClient.id);
  }, [open, openCalendar]);
  useEffect(() => { if (focus && data?.clients[0]) setOpen(data.clients[0].id); }, [focus, data?.clients[0]?.id]);

  const note = (key: string, value: string) => setNotes((current) => ({ ...current, [key]: value }));
  const draft = (key: string, fallback: string) => drafts[key] ?? fallback;
  const setDraft = (key: string, value: string) => setDrafts((current) => ({ ...current, [key]: value }));
  const clearDraft = (key: string) => setDrafts((current) => { const next = { ...current }; delete next[key]; return next; });

  const saveGlobal = async (patch: Record<string, unknown>, key: string) => {
    setBusy(key);
    const result = await call(settingsPath, { method: "POST", body: JSON.stringify({ global: patch }) });
    setBusy("");
    if (result.ok) { take(result.payload); note(key, "Saved"); } else note(key, result.error);
  };

  const saveClient = async (client: Client, patch: Record<string, unknown>) => {
    setBusy(client.id);
    note(client.id, "");
    const result = await call(settingsPath, { method: "POST", body: JSON.stringify({ workspaceId: client.id, ...patch }) });
    setBusy("");
    if (result.ok) take(result.payload);
    else note(client.id, result.error);
    return result.ok;
  };

  const connect = async (workspaceId: string, key: string) => {
    const token = (drafts[key] ?? "").trim();
    if (!token) return;
    setBusy(key);
    note(key, "");
    const result = await call("/api/bookings/calendly", { method: "POST", body: JSON.stringify({ token, workspaceId: workspaceId || undefined }) });
    setBusy("");
    if (result.ok) { clearDraft(key); await load(); note(key, `Connected (${result.payload.scope})`); } else note(key, result.error);
  };
  const connectCalCom = async (workspaceId: string, key: string) => {
    const apiKey = (drafts[key] ?? "").trim();
    if (!apiKey) return;
    setBusy(key);
    note(key, "");
    const result = await call("/api/bookings/calcom", { method: "POST", body: JSON.stringify({ apiKey, workspaceId: workspaceId || undefined }) });
    setBusy("");
    if (result.ok) { clearDraft(key); await load(); note(key, "Connected"); } else note(key, result.error);
  };
  const disconnectCalCom = async (workspaceId: string, key: string) => {
    setBusy(key);
    const result = await call(`/api/bookings/calcom${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, { method: "DELETE" });
    setBusy("");
    if (result.ok) await load(); else note(key, result.error);
  };
  const disconnect = async (workspaceId: string, key: string) => {
    setBusy(key);
    const result = await call(`/api/bookings/calendly${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, { method: "DELETE" });
    setBusy("");
    if (result.ok) await load(); else note(key, result.error);
  };

  const test = async (body: Record<string, unknown>, key: string, done: string) => {
    setBusy(key);
    note(key, "");
    const result = await call("/api/bookings/test", { method: "POST", body: JSON.stringify(body) });
    setBusy("");
    note(key, result.ok ? done : result.error);
    if (body.clay) window.setTimeout(() => void load(), 20_000);
  };

  const copy = (value: string, key: string) => {
    navigator.clipboard?.writeText(value).then(() => note(key, "Copied"), () => note(key, "Select and copy it"));
  };

  if (!data) {
    return (
      <main className="reports-hub">
        <button type="button" className="config-back" onClick={onBack}>{backLabel}</button>
        <div className="hub-lede"><h1>{focus ? "Booked meetings" : "Booked meetings"}</h1></div>
        {error ? <div className="config-error">{error}</div> : <div className="hub-empty">Loading…</div>}
      </main>
    );
  }

  const g = data.global;
  const on = data.clients.filter((client) => client.enabled).length;
  const last = g.lastClayCallback;

  const stepsFor = (client: Client) => client.steps;
  const setSteps = (client: Client, steps: Step[]) => saveClient(client, { steps });
  const hubspot = (client: Client) => client.steps.find((step) => step.type === "hubspot");
  const webhooks = (client: Client) => client.steps.filter((step) => step.type === "webhook");
  const toggleHubspot = (client: Client) => {
    const current = hubspot(client);
    const others = stepsFor(client).filter((step) => step.type !== "hubspot");
    return setSteps(client, current ? [...others, { ...current, enabled: !current.enabled }] : [...others, { id: "hubspot", type: "hubspot", enabled: true }]);
  };

  const oauthReady = g.calendlyOAuth.clientIdSet && g.calendlyOAuth.secretSet;
  const oauthHref = (workspaceId: string) => `/api/bookings/calendly/oauth?return=${encodeURIComponent(returnPath)}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ""}`;
  /** Calendly for the shared calendar ("") or one client: connected line, or Connect with Calendly with a token fallback. */
  const calendlyControls = (workspaceId: string, key: string, connection: { email: string; scope: string } | null) => (
    connection ? (
      <>
        <span className="booking-setup-value">{connection.email} · {connection.scope}</span>
        <button type="button" className="secondary-button" disabled={busy === key} onClick={() => void disconnect(workspaceId, key)}>Disconnect</button>
      </>
    ) : (
      <>
        {oauthReady ? <a className="primary-button booking-oauth" href={oauthHref(workspaceId)}>Connect with Calendly</a> : <span className="booking-setup-value">Add the OAuth app below to sign in</span>}
        <input type="password" className="booking-input" placeholder="or a personal access token" value={draft(key, "")} onChange={(event) => setDraft(key, event.target.value)} />
        <button type="button" className="secondary-button" disabled={busy === key || !draft(key, "").trim()} onClick={() => void connect(workspaceId, key)}>Connect</button>
      </>
    )
  );
  const calComControls = (workspaceId: string, key: string, connection: { email: string } | null) => (
    connection ? (
      <>
        <span className="booking-setup-value">{connection.email || "Connected"}</span>
        <button type="button" className="secondary-button" disabled={busy === key} onClick={() => void disconnectCalCom(workspaceId, key)}>Disconnect</button>
      </>
    ) : (
      <>
        <input type="password" className="booking-input" placeholder="cal.com API key" value={draft(key, "")} onChange={(event) => setDraft(key, event.target.value)} />
        <button type="button" className="secondary-button" disabled={busy === key || !draft(key, "").trim()} onClick={() => void connectCalCom(workspaceId, key)}>Connect</button>
      </>
    )
  );

  /** Ticking an event adds it to the client's trigger list; unticking removes it. Matched on the event type id. */
  const toggleEvent = (client: Client, event: { id: string; name: string; source: string }) => {
    const chosen = client.eventTypes.some((item) => item.id === event.id);
    void saveClient(client, { eventTypes: chosen ? client.eventTypes.filter((item) => item.id !== event.id) : [...client.eventTypes, { id: event.id, name: event.name, source: event.source }] });
  };

  return (
    <main className="reports-hub">
      <button type="button" className="config-back" onClick={onBack}>{backLabel}</button>
      <div className="hub-lede"><h1>{focus && data.clients[0] ? `${data.clients[0].name} booked meetings` : "Booked meetings"}</h1></div>

      <div className="hub-group-label">
        <span>Shared setup</span>
        {focus ? (
          <button type="button" className="booking-chip is-more" onClick={() => setSetupOpen((value) => !value)} aria-expanded={setupOpen}>
            {oauthReady ? "Calendly app saved" : "Calendly app missing"} · {g.clayWebhookUrl ? "Clay on" : "Clay off"} · {setupOpen ? "Hide" : "Edit"}
          </button>
        ) : <span />}
      </div>
      {setupOpen && <div className="booking-setup">
        {(!oauthReady || drafts.oauthOpen === "1") ? (
          <div className="booking-setup-row">
            <strong>Calendly app</strong>
            <input className="booking-input" placeholder={g.calendlyOAuth.clientIdSet ? "Client ID saved" : "OAuth client ID"} value={draft("oauthId", "")} onChange={(event) => setDraft("oauthId", event.target.value)} />
            <input type="password" className="booking-input" placeholder={g.calendlyOAuth.secretSet ? "Client secret saved" : "OAuth client secret"} value={draft("oauthSecret", "")} onChange={(event) => setDraft("oauthSecret", event.target.value)} />
            <button
              type="button"
              className="secondary-button"
              disabled={busy === "oauth" || (!draft("oauthId", "").trim() && !draft("oauthSecret", "").trim())}
              onClick={async () => {
                const patch: Record<string, string> = {};
                if (draft("oauthId", "").trim()) patch.calendlyClientId = draft("oauthId", "").trim();
                if (draft("oauthSecret", "").trim()) patch.calendlyClientSecret = draft("oauthSecret", "").trim();
                await saveGlobal(patch, "oauth");
                clearDraft("oauthId"); clearDraft("oauthSecret"); clearDraft("oauthOpen");
              }}
            >
              Save
            </button>
            <code className="booking-code">{g.calendlyOAuth.redirectUri}</code>
            <button type="button" className="secondary-button" onClick={() => copy(g.calendlyOAuth.redirectUri, "oauth")}>Copy redirect URI</button>
            {notes.oauth && <small>{notes.oauth}</small>}
          </div>
        ) : (
          <div className="booking-setup-row">
            <strong>Calendly app</strong>
            <span className="booking-setup-value">OAuth app saved</span>
            <button type="button" className="secondary-button" onClick={() => setDraft("oauthOpen", "1")}>Change</button>
          </div>
        )}

        <div className="booking-setup-row">
          <strong>Clay table</strong>
          {g.clayWebhookUrl && drafts.clayOpen !== "1" ? (
            <>
              <span className="booking-setup-value">Shared table connected</span>
              <code className="booking-code is-short">…{g.clayWebhookUrl.slice(-12)}</code>
              <button type="button" className="secondary-button" onClick={() => setDraft("clayOpen", "1")}>Change</button>
            </>
          ) : (<>
          <input
            className="booking-input is-wide"
            placeholder="Webhook URL of the shared table"
            value={draft("clayUrl", g.clayWebhookUrl)}
            onChange={(event) => setDraft("clayUrl", event.target.value)}
            onBlur={() => { const value = draft("clayUrl", g.clayWebhookUrl).trim(); clearDraft("clayUrl"); clearDraft("clayOpen"); if (value !== g.clayWebhookUrl) void saveGlobal({ clayWebhookUrl: value }, "clay"); }}
          />
          <input
            type="password"
            className="booking-input"
            placeholder={g.clayAuthSet ? "Auth token saved" : "Auth token (optional)"}
            value={draft("clayAuth", "")}
            onChange={(event) => setDraft("clayAuth", event.target.value)}
            onBlur={() => { const value = draft("clayAuth", "").trim(); clearDraft("clayAuth"); if (value) void saveGlobal({ clayAuthToken: value }, "clay"); }}
          />
          </>)}
          <label className="booking-wait">
            Wait
            <input
              type="number"
              min={1}
              max={120}
              value={draft("clayWait", String(g.clayWaitMinutes))}
              onChange={(event) => setDraft("clayWait", event.target.value)}
              onBlur={() => { const value = Number(draft("clayWait", String(g.clayWaitMinutes))); clearDraft("clayWait"); if (value !== g.clayWaitMinutes) void saveGlobal({ clayWaitMinutes: value }, "clay"); }}
            />
            min
          </label>
          <button type="button" className="secondary-button" disabled={busy === "clayTest" || !g.clayWebhookUrl} onClick={() => void test({ clay: true }, "clayTest", "Sample row sent")}>Send a sample row</button>
          {(notes.clay || notes.clayTest) && <small>{notes.clayTest || notes.clay}</small>}
        </div>

        <div className="booking-setup-row">
          <strong>Clay callback</strong>
          <code className="booking-code">{g.callbackUrl}</code>
          <button type="button" className="secondary-button" onClick={() => copy(g.callbackUrl, "callback")}>Copy</button>
          <small>
            {last ? `Last answer ${ago(last.at)}${last.test ? " (sample)" : ""} · ${last.fields.length} fields` : "No answer from Clay yet"}
            {notes.callback ? ` · ${notes.callback}` : ""}
          </small>
        </div>
        {last && last.fields.length > 0 && <div className="booking-fields">{last.fields.join(" · ")}</div>}
      </div>}

      <div className="hub-group-label">
        <span>{focus ? "Workflow" : "Clients"}</span>
        <span>{focus ? "" : `${on} on`}</span>
      </div>
      <ul className="brief-client-list">
        {data.clients.map((client) => {
          const connected = Boolean(client.ownCalendly || client.ownCalCom);
          const hasEvent = client.eventTypes.length > 0 || Boolean(client.eventFilter);
          const ready = Boolean(client.channel) && connected && hasEvent;
          const missing = [!connected && "a calendar", !hasEvent && "an event", !client.channel && "a channel"].filter(Boolean).join(", ");
          const expanded = open === client.id;
          const hs = hubspot(client);
          const lastLine = client.lastBooking ? `Last: ${client.lastBooking.name || "booking"} ${ago(client.lastBooking.at)}, ${STAGE[client.lastBooking.stage] ?? client.lastBooking.stage}` : "";
          return (
            <li key={client.id} className={`booking-client ${ready ? "brief-client" : "brief-client is-short"}`}>
              <div className="brief-client-who">
                <i className="brief-client-logo" style={client.logoUrl ? undefined : { background: client.tone }} aria-hidden="true">
                  {client.logoUrl ? <img src={client.logoUrl} alt="" /> : client.name.slice(0, 1).toUpperCase()}
                </i>
                <div>
                  <strong>{client.name}</strong>
                  <small>
                    {client.enabled ? `On since ${day(client.enabledAt)}` : "Off"}
                    {lastLine ? ` · ${lastLine}` : ""}
                    {notes[client.id] ? ` · ${notes[client.id]}` : ""}
                  </small>
                  {client.lastBooking?.error && client.lastBooking.stage !== "done" && <small className="booking-error">{client.lastBooking.error}</small>}
                </div>
              </div>
              <div className="brief-client-channels booking-fields-row">
                <span className={connected ? "brief-channel" : "brief-channel is-missing"}>
                  CALENDAR
                  <code>{client.ownCalendly ? "Calendly" : client.ownCalCom ? "cal.com" : "None"}</code>
                </span>
                <span className={hasEvent ? "brief-channel" : "brief-channel is-missing"}>
                  EVENT
                  <code>{client.eventTypes.length ? (client.eventTypes.length === 1 ? client.eventTypes[0].name : `${client.eventTypes.length} events`) : client.eventFilter ? `"${client.eventFilter}"` : "None"}</code>
                </span>
                <label className={client.channel ? "brief-channel" : "brief-channel is-missing"}>
                  CHANNEL
                  <input
                    className="reply-alert-channel"
                    placeholder="C09BOOKINGS"
                    value={draft(`channel:${client.id}`, client.channel)}
                    onChange={(event) => setDraft(`channel:${client.id}`, event.target.value)}
                    onBlur={() => { const value = draft(`channel:${client.id}`, client.channel).trim(); clearDraft(`channel:${client.id}`); if (value !== client.channel) void saveClient(client, { channel: value }); }}
                    disabled={busy === client.id}
                  />
                </label>
              </div>
              <div className="booking-steps">
                <span className="booking-chip is-on">Slack</span>
                <button
                  type="button"
                  className={hs?.enabled ? "booking-chip is-on" : "booking-chip"}
                  disabled={busy === client.id || (!client.hubspotConnected && !hs?.enabled)}
                  title={client.hubspotConnected ? "" : "No HubSpot token for this client (Deals)."}
                  onClick={() => void toggleHubspot(client)}
                >
                  HubSpot deal
                </button>
                {webhooks(client).map((step) => (
                  <span key={step.id} className={step.enabled ? "booking-chip is-on" : "booking-chip"}>{step.label || "Webhook"}</span>
                ))}
                <button type="button" className="booking-chip is-more" onClick={() => setOpen(expanded ? "" : client.id)} aria-expanded={expanded}>{expanded ? "Less" : connected ? "More" : "Connect"}</button>
              </div>
              <div className="brief-client-actions">
                <button
                  type="button"
                  className={client.enabled ? "brief-switch is-on" : "brief-switch"}
                  onClick={() => void saveClient(client, { enabled: !client.enabled })}
                  disabled={busy === client.id || (!client.enabled && !ready)}
                  title={ready ? "" : `Needs ${missing}.`}
                >
                  <span />{client.enabled ? "On" : "Off"}
                </button>
                <button type="button" className="secondary-button" disabled={busy === client.id || !data.testChannelSet} onClick={() => void test({ workspaceId: client.id }, client.id, "Test posted to the test channel")}>Send a test</button>
              </div>

              {expanded && (
                <div className="booking-more">
                  <div className="booking-more-row">
                    <strong>Calendly</strong>
                    {calendlyControls(client.id, `cal:${client.id}`, client.ownCalendly)}
                    {notes[`cal:${client.id}`] && <small>{notes[`cal:${client.id}`]}</small>}
                  </div>

                  <div className="booking-more-row">
                    <strong>cal.com</strong>
                    {calComControls(client.id, `calcom:${client.id}`, client.ownCalCom)}
                    {notes[`calcom:${client.id}`] && <small>{notes[`calcom:${client.id}`]}</small>}
                  </div>

                  <div className="booking-more-row is-list">
                    <strong>Runs on</strong>
                    {!connected ? (
                      <span className="booking-setup-value">Connect the client&apos;s calendar to choose its event</span>
                    ) : (() => {
                      const state = events[client.id];
                      // Chosen events stay listed even if the calendar stops returning them (renamed, deleted).
                      const listed = [...(state?.list ?? [])];
                      for (const chosen of client.eventTypes) if (!listed.some((event) => event.id === chosen.id)) listed.push({ source: chosen.source === "calcom" ? "calcom" : "calendly", id: chosen.id, name: chosen.name, slug: "", active: false, owner: "", url: "" });
                      return (
                        <div className="booking-event-list">
                          {listed.map((event) => (
                            <label key={event.id} className={event.active ? "booking-event" : "booking-event is-off"}>
                              <input type="checkbox" checked={client.eventTypes.some((item) => item.id === event.id)} disabled={busy === client.id} onChange={() => toggleEvent(client, event)} />
                              <span>{event.name}</span>
                              <small>{event.owner}{event.active ? "" : event.owner ? " · off" : "off"}</small>
                            </label>
                          ))}
                          {state?.loading && <small>Loading events…</small>}
                          {state && !state.loading && !listed.length && <small>No event types found on this calendar.</small>}
                          {state?.errors.map((message) => <small key={message} className="booking-error">{message}</small>)}
                          <button type="button" className="booking-chip is-more" disabled={state?.loading} onClick={() => void loadEvents(client.id)}>Refresh</button>
                        </div>
                      );
                    })()}
                  </div>

                  <div className="booking-more-row">
                    <strong>Posts as</strong>
                    <input
                      className="booking-input"
                      placeholder={`${client.name} Calls`}
                      value={draft(`bot:${client.id}`, client.botName)}
                      onChange={(event) => setDraft(`bot:${client.id}`, event.target.value)}
                      onBlur={() => { const value = draft(`bot:${client.id}`, client.botName).trim(); clearDraft(`bot:${client.id}`); if (value !== client.botName) void saveClient(client, { botName: value }); }}
                    />
                  </div>

                  {hs && (
                    <div className="booking-more-row">
                      <strong>HubSpot deal</strong>
                      {(["stage", "pipeline", "owner", "campaignProperty"] as const).map((field) => (
                        <input
                          key={field}
                          className="booking-input is-narrow"
                          placeholder={{ stage: "appointmentscheduled", pipeline: "default", owner: "Owner id", campaignProperty: "campaign" }[field]}
                          title={{ stage: "Deal stage id", pipeline: "Pipeline id", owner: "Deal owner id", campaignProperty: "Deal property for the campaign" }[field]}
                          value={draft(`hs:${field}:${client.id}`, hs[field] ?? "")}
                          onChange={(event) => setDraft(`hs:${field}:${client.id}`, event.target.value)}
                          onBlur={() => {
                            const value = draft(`hs:${field}:${client.id}`, hs[field] ?? "").trim();
                            clearDraft(`hs:${field}:${client.id}`);
                            if (value !== (hs[field] ?? "")) void setSteps(client, stepsFor(client).map((step) => (step.type === "hubspot" ? { ...step, [field]: value } : step)));
                          }}
                        />
                      ))}
                    </div>
                  )}

                  <div className="booking-more-row is-list">
                    <strong>Webhooks</strong>
                    {webhooks(client).map((step) => (
                      <span key={step.id} className="booking-webhook">
                        <code className="booking-code">{step.url}</code>
                        <button type="button" className="secondary-button" onClick={() => void setSteps(client, stepsFor(client).map((s) => (s.id === step.id ? { ...s, enabled: !s.enabled } : s)))}>{step.enabled ? "Pause" : "Resume"}</button>
                        <button type="button" className="secondary-button" onClick={() => void setSteps(client, stepsFor(client).filter((s) => s.id !== step.id))}>Remove</button>
                      </span>
                    ))}
                    <span className="booking-webhook">
                      <input className="booking-input is-wide" placeholder="https://…" value={draft(`hook:${client.id}`, "")} onChange={(event) => setDraft(`hook:${client.id}`, event.target.value)} />
                      <input className="booking-input is-narrow" placeholder="Label" value={draft(`hookLabel:${client.id}`, "")} onChange={(event) => setDraft(`hookLabel:${client.id}`, event.target.value)} />
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!/^https:\/\//i.test(draft(`hook:${client.id}`, "").trim())}
                        onClick={async () => {
                          const url = draft(`hook:${client.id}`, "").trim();
                          const label = draft(`hookLabel:${client.id}`, "").trim();
                          const id = `webhook_${Date.now().toString(36)}`;
                          if (await setSteps(client, [...stepsFor(client), { id, type: "webhook", enabled: true, url, label }])) { clearDraft(`hook:${client.id}`); clearDraft(`hookLabel:${client.id}`); }
                        }}
                      >
                        Add
                      </button>
                    </span>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {focus && data.clients[0] && (() => {
        const client = data.clients[0];
        const aboutKey = `about:${client.id}`;
        const rulesKey = `rules:${client.id}`;
        const about = draft(aboutKey, client.briefAbout);
        const rules = draft(rulesKey, client.briefInstructions || data.defaultBriefInstructions);
        const dirty = about !== client.briefAbout || rules !== (client.briefInstructions || data.defaultBriefInstructions);
        const save = async () => {
          const ok = await saveClient(client, { briefAbout: about, briefInstructions: rules.trim() === data.defaultBriefInstructions.trim() ? "" : rules });
          if (ok) { clearDraft(aboutKey); clearDraft(rulesKey); note("brief", "Saved"); }
        };
        const run = async () => {
          setBusy("brief");
          note("brief", "");
          setPreview(null);
          const result = await call("/api/bookings/test", { method: "POST", body: JSON.stringify({ workspaceId: client.id, preview: true, about, instructions: rules }) });
          setBusy("");
          if (result.ok) setPreview({ brief: result.payload.tldr, who: [result.payload.meeting?.name, result.payload.meeting?.company].filter(Boolean).join(", ") });
          else note("brief", result.error);
        };
        return (
          <>
            <div className="hub-group-label"><span>Pre-call brief</span><span>{client.briefInstructions ? "Custom" : "Default"}</span></div>
            <div className="booking-setup booking-brief">
              <label className="booking-brief-field">
                <strong>About {client.name}</strong>
                <textarea
                  rows={5}
                  value={about}
                  placeholder={client.clientBrief ? `Uses the client brief:\n${client.clientBrief.slice(0, 600)}` : "Two or three paragraphs on what the client sells and who it is for."}
                  onChange={(event) => setDraft(aboutKey, event.target.value)}
                />
              </label>
              <label className="booking-brief-field">
                <strong>Instructions</strong>
                <textarea rows={9} value={rules} onChange={(event) => setDraft(rulesKey, event.target.value)} />
              </label>
              <div className="booking-setup-row">
                <button type="button" className="secondary-button" disabled={busy === client.id || !dirty} onClick={() => void save()}>Save</button>
                <button type="button" className="secondary-button" disabled={busy === "brief" || !client.recent.length} onClick={() => void run()}>{busy === "brief" ? "Writing…" : "Preview on the latest booking"}</button>
                <button type="button" className="secondary-button" disabled={rules === data.defaultBriefInstructions} onClick={() => setDraft(rulesKey, data.defaultBriefInstructions)}>Reset instructions</button>
                {notes.brief && <small>{notes.brief}</small>}
              </div>
              {preview && (
                <div className="booking-preview">
                  <small>{preview.who}</small>
                  {([["leadSummary", "Lead Summary"], ["companySummary", "Company Summary"], ["callFocus", "Call Focus"], ["painPoints", "Pain Points"]] as const).map(([key, label]) =>
                    preview.brief[key] ? (<div key={key}><strong>{label}</strong><p>{preview.brief[key]}</p></div>) : null)}
                </div>
              )}
            </div>

            <div className="hub-group-label"><span>Recent bookings</span><span>{client.recent.length}</span></div>
            {client.recent.length ? (
              <ul className="booking-recent">
                {client.recent.map((row) => (
                  <li key={row.id}>
                    <strong>{row.name || "Someone"}</strong>
                    <span>{row.company}</span>
                    <span>{ago(row.at)}</span>
                    <span className={row.stage === "failed" ? "booking-error" : ""}>
                      {STAGE[row.stage] ?? row.stage}{row.clay ? " · Clay" : row.clayTimedOut ? " · Clay timed out" : ""}
                    </span>
                    {row.error && row.stage !== "done" && <small className="booking-error">{row.error}</small>}
                  </li>
                ))}
              </ul>
            ) : <div className="hub-empty">No bookings through QC yet.</div>}
          </>
        );
      })()}
      {!data.testChannelSet && <div className="hub-empty">Set <code>SLACK_TEST_CHANNEL_ID</code> to send tests.</div>}
      {error && <div className="config-error">{error}</div>}
    </main>
  );
}
