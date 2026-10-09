// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * A client's booked meetings workflow on its Operations page, as six numbered steps: connect the calendar,
 * choose the events, post to Slack, where else each booking goes, the pre-call brief, turn it on. Everything
 * saves on its own. The About section is written by QC (QC Brain, the website, a web search), never typed.
 * The pipeline is app/lib/booking-run.ts; every client at once (and the shared setup) is on the Slack tab.
 */

type Step = { id: string; type: string; enabled: boolean; url?: string; label?: string };
type Client = {
  id: string;
  name: string;
  enabled: boolean;
  enabledAt: string | null;
  eventFilter: string;
  channel: string;
  botName: string;
  steps: Step[];
  eventTypes: Array<{ id: string; name: string; source: string }>;
  ownCalendly: { email: string; scope: string } | null;
  ownCalCom: { email: string } | null;
  briefAbout: string;
  briefAboutSources?: string[];
  briefAboutAt?: string | null;
  briefInstructions: string;
  recent: Array<{ id: string; name: string; company: string; at: string; stage: string; error: string; clay: boolean; clayTimedOut: boolean }>;
};
type Payload = {
  ok: boolean;
  global: { clayWebhookUrl: string; calendlyOAuth: { clientIdSet: boolean; secretSet: boolean }; lastClayCallback: { at: string; test: boolean; fields: string[] } | null };
  clients: Client[];
  testChannelSet: boolean;
  defaultBriefInstructions: string;
};
type CalendarEvent = { source: "calendly" | "calcom"; id: string; name: string; active: boolean; owner: string };
type Brief = { leadSummary?: string; companySummary?: string; callFocus?: string; painPoints?: string };
export type DealsState = { provider: "HubSpot" | "Attio"; live: boolean; where: string } | null;

const STAGE: Record<string, string> = { new: "Received", enriching: "Waiting on Clay", ready: "Posting", done: "Posted", failed: "Failed", skipped: "Skipped" };
const when = (value: string | null | undefined) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

async function call(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  return { ok: Boolean(response?.ok && payload?.ok !== false), payload, error: String(payload?.error || (response ? `Failed (${response.status}).` : "Network error.")) };
}

function StepCard({ n, state, title, status, children }: { n: number; state: "done" | "now" | "later"; title: string; status: string; children?: React.ReactNode }) {
  return (
    <section className={`ops-panel bk-step bk-${state}`} aria-label={`Step ${n}: ${title}`}>
      <span className="bk-num" aria-hidden="true">{state === "done" ? "✓" : n}</span>
      <div className="bk-body">
        <div className="bk-head"><h2>{title}</h2><span className="ops-label">{status}</span></div>
        {children}
      </div>
    </section>
  );
}

export default function BookingSetup({ slug, deals }: { slug: string; deals: DealsState }) {
  const settingsPath = `/api/bookings/settings?client=${encodeURIComponent(slug)}`;
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<{ list: CalendarEvent[]; errors: string[]; loading: boolean } | null>(null);
  const [preview, setPreview] = useState<{ brief: Brief; who: string } | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [clayWaiting, setClayWaiting] = useState<string | null>(null);
  const saved = useRef<Record<string, number>>({});

  const take = (payload: Payload | null) => { if (payload?.global) { setData(payload); setError(""); } };
  const load = async () => {
    const result = await call(settingsPath);
    if (result.ok) take(result.payload); else setError(result.error);
  };
  useEffect(() => { void load(); }, [settingsPath]);
  // Back from Calendly's sign-in: say how it went.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("calendly");
    if (!status) return;
    setNote((current) => ({ ...current, calendar: status === "connected" ? "Calendly connected." : status }));
    params.delete("calendly");
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }, []);

  const client = data?.clients[0] ?? null;
  const connected = Boolean(client?.ownCalendly || client?.ownCalCom);
  const calendarKey = `${client?.ownCalendly?.email ?? ""}|${client?.ownCalCom?.email ?? ""}`;
  const loadEvents = async () => {
    if (!client) return;
    setEvents((current) => ({ list: current?.list ?? [], errors: [], loading: true }));
    const result = await call(`/api/bookings/events?workspaceId=${encodeURIComponent(client.id)}`);
    setEvents({ list: result.ok ? result.payload.events : [], errors: result.ok ? result.payload.errors : [result.error], loading: false });
  };
  useEffect(() => { if (connected) void loadEvents(); }, [client?.id, calendarKey]);

  const draft = (key: string, fallback: string) => drafts[key] ?? fallback;
  const setDraft = (key: string, value: string) => setDrafts((current) => ({ ...current, [key]: value }));
  const clearDraft = (key: string) => setDrafts((current) => { const next = { ...current }; delete next[key]; return next; });

  /** Every change saves on its own; the field shows "Saved" for a moment after. */
  const save = async (patch: Record<string, unknown>, key: string) => {
    if (!client) return false;
    setBusy(key);
    const result = await call(settingsPath, { method: "POST", body: JSON.stringify({ workspaceId: client.id, ...patch }) });
    setBusy("");
    if (result.ok) { take(result.payload); saved.current[key] = Date.now(); setNote((current) => ({ ...current, [key]: "Saved" })); }
    else setNote((current) => ({ ...current, [key]: result.error }));
    return result.ok;
  };
  const blurSave = (key: string, field: string, current: string) => {
    const value = draft(key, current).trim();
    clearDraft(key);
    if (value !== current) void save({ [field]: value }, key);
  };

  if (!data || !client) {
    return <div className="ops-stack">{error ? <p className="ops-error">{error}</p> : <p className="ops-muted">Loading booked meetings…</p>}</div>;
  }

  const hasEvent = client.eventTypes.length > 0 || Boolean(client.eventFilter);
  const hasChannel = Boolean(client.channel);
  const hasAbout = Boolean(client.briefAbout.trim());
  const ready = connected && hasEvent && hasChannel;
  const oldHubspot = client.steps.find((step) => step.type === "hubspot" && step.enabled);
  const webhooks = client.steps.filter((step) => step.type === "webhook");
  const done = [connected, hasEvent, hasChannel, true, hasAbout, client.enabled];
  const firstOpen = done.findIndex((value) => !value);
  const state = (index: number): "done" | "now" | "later" => (done[index] ? "done" : index === firstOpen ? "now" : "later");
  const left = done.filter((value) => !value).length;
  const NAMES = ["Calendar", "Events", "Slack", "Destinations", "Brief", "Turn on"];
  const oauthReady = data.global.calendlyOAuth.clientIdSet && data.global.calendlyOAuth.secretSet;
  const returnTo = `/operations/${slug}?view=meetings`;

  const connectToken = async (kind: "calendly" | "calcom") => {
    const key = kind === "calendly" ? "calToken" : "calcomKey";
    const value = draft(key, "").trim();
    if (!value) return;
    setBusy(key);
    const result = await call(`/api/bookings/${kind}`, { method: "POST", body: JSON.stringify(kind === "calendly" ? { token: value, workspaceId: client.id } : { apiKey: value, workspaceId: client.id }) });
    setBusy("");
    if (result.ok) { clearDraft(key); await load(); setNote((current) => ({ ...current, calendar: "Connected." })); } else setNote((current) => ({ ...current, calendar: result.error }));
  };
  const disconnect = async (kind: "calendly" | "calcom") => {
    setBusy(`off:${kind}`);
    const result = await call(`/api/bookings/${kind}?workspaceId=${encodeURIComponent(client.id)}`, { method: "DELETE" });
    setBusy("");
    if (result.ok) await load(); else setNote((current) => ({ ...current, calendar: result.error }));
  };
  const toggleEvent = (event: { id: string; name: string; source: string }) => {
    const chosen = client.eventTypes.some((item) => item.id === event.id);
    void save({ eventTypes: chosen ? client.eventTypes.filter((item) => item.id !== event.id) : [...client.eventTypes, { id: event.id, name: event.name, source: event.source }] }, "events");
  };
  const writeAbout = async () => {
    setBusy("about");
    setNote((current) => ({ ...current, about: "" }));
    const result = await call("/api/bookings/about", { method: "POST", body: JSON.stringify({ slug }) });
    setBusy("");
    if (!result.ok) { setNote((current) => ({ ...current, about: result.error })); return; }
    clearDraft("about");
    await save({ briefAbout: result.payload.about, briefAboutSources: result.payload.sources }, "about");
  };
  const previewBrief = async () => {
    setBusy("preview");
    setPreview(null);
    const result = await call("/api/bookings/test", { method: "POST", body: JSON.stringify({ workspaceId: client.id, preview: true, about: client.briefAbout, instructions: client.briefInstructions || data.defaultBriefInstructions }) });
    setBusy("");
    if (result.ok) setPreview({ brief: result.payload.tldr, who: [result.payload.meeting?.name, result.payload.meeting?.company].filter(Boolean).join(", ") });
    else setNote((current) => ({ ...current, preview: result.error }));
  };
  const sendTest = async () => {
    setBusy("test");
    const result = await call("/api/bookings/test", { method: "POST", body: JSON.stringify({ workspaceId: client.id }) });
    setBusy("");
    setNote((current) => ({ ...current, test: result.ok ? "Latest booking posted to the test channel." : result.error }));
  };
  /** A test lead to Clay with this client's name, then watch for Clay's answer for a minute. */
  const sendClayTest = async () => {
    const lead = { name: draft("tName", "").trim(), email: draft("tEmail", "").trim(), company: draft("tCompany", "").trim(), title: draft("tTitle", "").trim() };
    setBusy("clay");
    const sentAt = new Date().toISOString();
    const result = await call("/api/bookings/test", { method: "POST", body: JSON.stringify({ clay: true, workspaceId: client.id, lead }) });
    setBusy("");
    if (!result.ok) { setNote((current) => ({ ...current, test: result.error })); return; }
    setNote((current) => ({ ...current, test: `Sent ${lead.name || lead.email} to Clay with client ${client.name}. Waiting for Clay's answer…` }));
    setClayWaiting(sentAt);
    for (let i = 0; i < 12; i += 1) {
      await new Promise((done) => setTimeout(done, 5000));
      const fresh = await call(settingsPath);
      if (!fresh.ok) continue;
      take(fresh.payload);
      const answer = (fresh.payload as Payload).global.lastClayCallback;
      if (answer?.test && answer.at >= sentAt) {
        setNote((current) => ({ ...current, test: `Clay answered with ${answer.fields.length} ${answer.fields.length === 1 ? "field" : "fields"}${answer.fields.length ? `: ${answer.fields.join(", ")}` : ""}.` }));
        setClayWaiting(null);
        return;
      }
    }
    setNote((current) => ({ ...current, test: "Sent to Clay. No answer within a minute: check the table's HTTP column runs and posts back." }));
    setClayWaiting(null);
  };
  const setSteps = (steps: Step[], key: string) => save({ steps }, key);

  // The events list keeps chosen events even if the calendar stops returning them (renamed, deleted).
  const listed: CalendarEvent[] = [...(events?.list ?? [])];
  for (const chosen of client.eventTypes) if (!listed.some((event) => event.id === chosen.id)) listed.push({ source: chosen.source === "calcom" ? "calcom" : "calendly", id: chosen.id, name: chosen.name, active: false, owner: "" });
  const rules = draft("rules", client.briefInstructions || data.defaultBriefInstructions);

  return (
    <div className="ops-stack">
      <div className="ops-titlebar">
        <div>
          <span className="ops-label">Booked meetings · pulse check</span>
          <h1>{client.enabled ? `As of ${when(new Date().toISOString())}, booked meetings are flowing.` : `Booked meetings aren't on yet. ${left} ${left === 1 ? "step" : "steps"} left.`}</h1>
        </div>
      </div>

      <nav className="ops-panel bk-progress" aria-label="Setup progress">
        {NAMES.map((name, index) => (
          <span key={name} className={`bk-prog bk-${state(index)}`}><span className="bk-dot">{done[index] ? "✓" : index + 1}</span>{name}</span>
        ))}
      </nav>

      <StepCard n={1} state={state(0)} title={`Connect ${client.name}'s calendar`} status={connected ? "Done" : "To do"}>
        {connected ? (
          <div className="bk-connected">
            {client.ownCalendly && <div className="bk-line"><strong>Calendly</strong><span>{client.ownCalendly.email}</span><button type="button" className="ops-link ops-danger" disabled={busy === "off:calendly"} onClick={() => void disconnect("calendly")}>Disconnect</button></div>}
            {client.ownCalCom && <div className="bk-line"><strong>cal.com</strong><span>{client.ownCalCom.email || "Connected"}</span><button type="button" className="ops-link ops-danger" disabled={busy === "off:calcom"} onClick={() => void disconnect("calcom")}>Disconnect</button></div>}
          </div>
        ) : (
          <>
            <p className="ops-muted">The calendar their prospects book on. QC only reads bookings.</p>
            <div className="bk-two">
              <div className="bk-option">
                <strong>Calendly</strong>
                {oauthReady ? <a className="ops-btn ops-pri" href={`/api/bookings/calendly/oauth?return=${encodeURIComponent(returnTo)}&workspaceId=${encodeURIComponent(client.id)}`}>Sign in with Calendly</a> : <span className="ops-muted">QC's Calendly app isn't set up yet (Slack tab, Booked meetings).</span>}
                <div className="ops-row"><input className="ops-input ops-grow" type="password" placeholder="or a personal access token" aria-label="Calendly access token" value={draft("calToken", "")} onChange={(e) => setDraft("calToken", e.target.value)} /><button type="button" className="ops-btn ops-sec" disabled={busy === "calToken" || !draft("calToken", "").trim()} onClick={() => void connectToken("calendly")}>Connect</button></div>
              </div>
              <div className="bk-option">
                <strong>cal.com</strong>
                <div className="ops-row"><input className="ops-input ops-grow" type="password" placeholder="cal.com API key" aria-label="cal.com API key" value={draft("calcomKey", "")} onChange={(e) => setDraft("calcomKey", e.target.value)} /><button type="button" className="ops-btn ops-sec" disabled={busy === "calcomKey" || !draft("calcomKey", "").trim()} onClick={() => void connectToken("calcom")}>Connect</button></div>
              </div>
            </div>
          </>
        )}
        {note.calendar && <p className={note.calendar.startsWith("Connected") || note.calendar.startsWith("Calendly connected") ? "ops-ok" : "ops-error"}>{note.calendar}</p>}
      </StepCard>

      <StepCard n={2} state={state(1)} title="Choose the events it runs on" status={hasEvent ? "Done" : connected ? "To do" : "After step 1"}>
        {connected && (
          <div className="bk-events">
            {listed.map((event) => (
              <label key={event.id} className={`ops-check bk-event${event.active ? "" : " bk-off"}`}>
                <input type="checkbox" checked={client.eventTypes.some((item) => item.id === event.id)} disabled={busy === "events"} onChange={() => toggleEvent(event)} />
                <span>{event.name}</span>
                <small className="ops-faint">{[event.owner, event.active ? "" : "off"].filter(Boolean).join(" · ")}</small>
              </label>
            ))}
            {events?.loading && <p className="ops-muted">Loading events…</p>}
            {events && !events.loading && !listed.length && <p className="ops-muted">No event types on this calendar.</p>}
            {events?.errors.map((message) => <p key={message} className="ops-error">{message}</p>)}
            <button type="button" className="ops-link" disabled={events?.loading} onClick={() => void loadEvents()}>Refresh events</button>
          </div>
        )}
      </StepCard>

      <StepCard n={3} state={state(2)} title="Post to Slack" status={hasChannel ? "Done" : "To do"}>
        <div className="bk-two">
          <label className="ops-field">Channel ID
            <input className="ops-input" placeholder="C09BOOKINGS" value={draft("channel", client.channel)} onChange={(e) => setDraft("channel", e.target.value)} onBlur={() => blurSave("channel", "channel", client.channel)} />
          </label>
          <label className="ops-field">Posts as
            <input className="ops-input" placeholder={`${client.name} Calls`} value={draft("bot", client.botName)} onChange={(e) => setDraft("bot", e.target.value)} onBlur={() => blurSave("bot", "botName", client.botName)} />
          </label>
        </div>
        {(note.channel || note.bot) && <p className={(note.channel || note.bot) === "Saved" ? "ops-ok" : "ops-error"}>{note.channel || note.bot}</p>}
      </StepCard>

      <StepCard n={4} state={state(3)} title="Where else each booking goes" status="Done">
        <div className="bk-chips">
          {deals
            ? <span className={`bk-chip${deals.live ? " bk-chip-on" : ""}`}>{deals.live ? "✓" : "○"} {deals.provider} deal · {deals.live ? deals.where : "set up in the " + deals.provider + " view"}</span>
            : <span className="bk-chip">○ No CRM connected (HubSpot or Attio view)</span>}
          <span className={`bk-chip${data.global.clayWebhookUrl ? " bk-chip-on" : ""}`}>{data.global.clayWebhookUrl ? "✓" : "○"} Clay enrichment</span>
          {webhooks.map((step) => (
            <span key={step.id} className={`bk-chip${step.enabled ? " bk-chip-on" : ""}`}>
              {step.enabled ? "✓" : "○"} {step.label || "Webhook"}
              <button type="button" className="ops-link" onClick={() => void setSteps(client.steps.map((item) => (item.id === step.id ? { ...item, enabled: !item.enabled } : item)), "hooks")}>{step.enabled ? "Pause" : "Resume"}</button>
              <button type="button" className="ops-link ops-danger" onClick={() => void setSteps(client.steps.filter((item) => item.id !== step.id), "hooks")}>Remove</button>
            </span>
          ))}
        </div>
        {oldHubspot && (
          <div className="ops-alert" role="alert">
            <div className="ops-alert-title">The old HubSpot deal step is still on.</div>
            <div className="ops-alert-detail">Deals now come from the {deals?.provider ?? "CRM"} connection. With both on, every booking makes two deals.</div>
            <div className="ops-row"><button type="button" className="ops-btn ops-alert-btn" onClick={() => void setSteps(client.steps.map((item) => (item.type === "hubspot" ? { ...item, enabled: false } : item)), "hooks")}>Turn the old step off</button></div>
          </div>
        )}
        <div className="ops-row">
          <input className="ops-input ops-grow" placeholder="Webhook https://…" aria-label="Webhook URL" value={draft("hook", "")} onChange={(e) => setDraft("hook", e.target.value)} />
          <input className="ops-input" placeholder="Label" aria-label="Webhook label" value={draft("hookLabel", "")} onChange={(e) => setDraft("hookLabel", e.target.value)} />
          <button type="button" className="ops-btn ops-sec" disabled={!/^https:\/\//i.test(draft("hook", "").trim())} onClick={async () => {
            if (await setSteps([...client.steps, { id: `webhook_${Date.now().toString(36)}`, type: "webhook", enabled: true, url: draft("hook", "").trim(), label: draft("hookLabel", "").trim() }], "hooks")) { clearDraft("hook"); clearDraft("hookLabel"); }
          }}>Add webhook</button>
        </div>
      </StepCard>

      <StepCard n={5} state={state(4)} title="Pre-call brief" status={hasAbout ? "Saved automatically" : "To do"}>
        <div className="bk-box">
          <div className="bk-box-head">
            <strong>About {client.name}</strong>
            <button type="button" className={`ops-btn ${hasAbout ? "ops-sec" : "ops-pri"}`} disabled={busy === "about"} onClick={() => void writeAbout()}>{busy === "about" ? "Researching and writing…" : hasAbout ? "↻ Write it again" : "Write it for me"}</button>
          </div>
          {hasAbout || drafts.about !== undefined ? (
            <textarea className="ops-input bk-text" rows={7} value={draft("about", client.briefAbout)} onChange={(e) => setDraft("about", e.target.value)} onBlur={() => blurSave("about", "briefAbout", client.briefAbout)} aria-label={`About ${client.name}`} />
          ) : (
            <p className="ops-muted">QC writes this from {client.name}'s QC Brain folder, its website and a web search. You never have to.</p>
          )}
          <div className="bk-sources">
            {(client.briefAboutSources ?? []).length > 0 && <span className="ops-label">Sources</span>}
            {(client.briefAboutSources ?? []).map((source) => <span key={source} className="bk-chip">{source}</span>)}
            <span className="bk-saved">{busy === "about" ? "" : note.about && note.about !== "Saved" ? <span className="ops-error">{note.about}</span> : client.briefAboutAt ? `Written ${when(client.briefAboutAt)} · saved` : hasAbout ? "Saved" : ""}</span>
          </div>
        </div>
        <div className="bk-box">
          <div className="bk-box-head">
            <div><strong>Instructions</strong><div className="ops-muted">{client.briefInstructions ? "Custom" : "Default"}: lead summary, company summary, call focus, pain points</div></div>
            <button type="button" className="ops-btn ops-sec" onClick={() => setRulesOpen((value) => !value)}>{rulesOpen ? "Done" : "Edit"}</button>
          </div>
          {rulesOpen && (
            <>
              <textarea className="ops-input bk-text" rows={9} value={rules} onChange={(e) => setDraft("rules", e.target.value)} onBlur={() => { const value = draft("rules", rules); clearDraft("rules"); const stored = value.trim() === data.defaultBriefInstructions.trim() ? "" : value; if (stored !== client.briefInstructions) void save({ briefInstructions: stored }, "rules"); }} aria-label="Brief instructions" />
              <div className="ops-row ops-quiet">
                <button type="button" className="ops-link" disabled={!client.briefInstructions} onClick={() => { clearDraft("rules"); void save({ briefInstructions: "" }, "rules"); }}>Reset to default</button>
                {note.rules && <span className={note.rules === "Saved" ? "ops-ok" : "ops-error"}>{note.rules}</span>}
              </div>
            </>
          )}
        </div>
        <div className="ops-row">
          <button type="button" className="ops-btn ops-sec" disabled={busy === "preview" || !client.recent.length} onClick={() => void previewBrief()}>{busy === "preview" ? "Writing…" : "Preview on the latest booking"}</button>
          {!client.recent.length && <span className="ops-muted">Available after the first booking.</span>}
          {note.preview && <span className="ops-error">{note.preview}</span>}
        </div>
        {preview && (
          <div className="bk-preview">
            <span className="ops-label">{preview.who}</span>
            {([["leadSummary", "Lead summary"], ["companySummary", "Company summary"], ["callFocus", "Call focus"], ["painPoints", "Pain points"]] as const).map(([key, label]) =>
              preview.brief[key] ? <div key={key}><strong>{label}</strong><p>{preview.brief[key]}</p></div> : null)}
          </div>
        )}
      </StepCard>

      <StepCard n={6} state={state(5)} title="Turn it on" status={client.enabled ? `On since ${when(client.enabledAt)}` : ready ? "Ready" : "Needs steps 1 to 3"}>
        <div className="ops-row">
          <label className="ops-check bk-switch"><input type="checkbox" checked={client.enabled} disabled={busy === "enabled" || (!client.enabled && !ready)} onChange={(e) => void save({ enabled: e.target.checked }, "enabled")} /> {client.enabled ? "On" : "Off"}</label>
          <button type="button" className="ops-btn ops-sec" aria-expanded={testOpen} onClick={() => setTestOpen((value) => !value)}>Send a test {testOpen ? "▴" : "▾"}</button>
          {note.enabled && note.enabled !== "Saved" && <span className="ops-error">{note.enabled}</span>}
        </div>
        {testOpen && (
          <div className="bk-box">
            <div className="bk-box-head"><strong>Test lead</strong><span className="ops-muted">Goes to the Clay table as a test, with client {client.name}</span></div>
            <div className="bk-two">
              <label className="ops-field">Name<input className="ops-input" value={draft("tName", "")} onChange={(e) => setDraft("tName", e.target.value)} /></label>
              <label className="ops-field">Email<input className="ops-input" type="email" value={draft("tEmail", "")} onChange={(e) => setDraft("tEmail", e.target.value)} /></label>
              <label className="ops-field">Company name<input className="ops-input" value={draft("tCompany", "")} onChange={(e) => setDraft("tCompany", e.target.value)} /></label>
              <label className="ops-field">Job title<input className="ops-input" value={draft("tTitle", "")} onChange={(e) => setDraft("tTitle", e.target.value)} /></label>
            </div>
            <div className="ops-row">
              <button type="button" className="ops-btn ops-pri" disabled={busy === "clay" || Boolean(clayWaiting) || !data.global.clayWebhookUrl || (!draft("tName", "").trim() && !draft("tEmail", "").trim())} onClick={() => void sendClayTest()}>{busy === "clay" ? "Sending…" : clayWaiting ? "Waiting for Clay…" : "Send to Clay"}</button>
              {client.recent.length > 0 && data.testChannelSet && <button type="button" className="ops-btn ops-sec" disabled={busy === "test"} onClick={() => void sendTest()}>{busy === "test" ? "Posting…" : "Post the latest booking to the test channel"}</button>}
              {!data.global.clayWebhookUrl && <span className="ops-muted">No Clay table is connected (shared setup).</span>}
            </div>
            {note.test && <p className={/^(Clay answered|Sent|Latest booking posted)/.test(note.test) ? "ops-ok" : "ops-error"}>{note.test}</p>}
          </div>
        )}
      </StepCard>

      <section className="ops-panel ops-flush" aria-label="Recent bookings">
        <div className="ops-panel-head"><span className="ops-label">Recent bookings · {client.recent.length}</span><Link href="/slack?view=bookings" className="ops-link">Shared setup (Calendly app, Clay) ↗</Link></div>
        {client.recent.length ? (
          <ul className="bk-recent">
            {client.recent.map((row) => (
              <li key={row.id}>
                <div><strong>{row.company || row.name || "Someone"}</strong><span>{row.company ? row.name : ""}</span></div>
                <span className="ops-faint">{when(row.at)}</span>
                <span className={row.stage === "failed" ? "ops-error" : row.stage === "done" ? "ops-ok" : "ops-muted"}>{STAGE[row.stage] ?? row.stage}{row.clay ? " · Clay" : row.clayTimedOut ? " · Clay timed out" : ""}</span>
                {row.error && row.stage !== "done" && <small className="ops-error">{row.error}</small>}
              </li>
            ))}
          </ul>
        ) : <p className="ops-muted bk-empty">No bookings through QC yet.</p>}
      </section>
    </div>
  );
}
