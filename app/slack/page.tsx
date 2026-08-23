// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * The Slack hub: which automations exist, which client to run one for, and the run itself.
 *
 * ── Automations first, clients second ────────────────────────────────────────────────────────────
 * The reports hub goes clients → templates, because a report is a thing you make for one client and
 * you already know which. This goes the other way round: an automation is a standing arrangement that
 * applies to every client, so the question is "which automation" and only then "for whom". Same three
 * screens, opposite order.
 *
 * ── The middle screen exists to make a missing source visible ────────────────────────────────────
 * A brief will be written with two of its three sources and read as though it had all three, so the
 * client list is not a list of names — it is three marks per client saying whether their campaign
 * figures are arriving, whether their channels are set, and whether their call can be found. A client
 * cannot be switched on until all three are there, because switching one on is a promise that the brief
 * posted into a client-facing channel on Monday morning is complete.
 *
 * ── The stylesheet is the reports one, deliberately ──────────────────────────────────────────────
 * `reports.css` carries `.client-grid`, `.hub-card` and the rest, and this hub is supposed to be the
 * same object. Importing it is what makes the two identical rather than merely similar — a second copy
 * of those rules would drift the first time either is touched.
 */

import { useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import BriefView from "../components/BriefView";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import { DAY_NAMES, DEFAULT_SCHEDULE, describeSchedule, type BriefSchedule, type Check } from "../lib/morning-brief-schedule";
import type { TraceStep } from "../lib/morning-brief";
import "../reports/reports.css";

/**
 * The two Slack automations, and the one screen that drives both.
 *
 * They are the same object with different sources: a morning brief reconciles three (campaign figures,
 * Slack, the last call); a call analysis reads one (the weekly call transcript). So the hub is written
 * once and parameterised by which automation is open — the endpoint, the labels, the readiness checks and
 * the destinations all come off `automation` rather than being duplicated into two near-identical pages.
 */
type Automation = "morning_brief" | "call_analysis" | "eow_report";

/** Which route each automation talks to. All expose the same GET/POST/PATCH shape. */
const API: Record<Automation, string> = {
  morning_brief: "/api/slack/brief",
  call_analysis: "/api/slack/call-analysis",
  eow_report: "/api/slack/eow-report",
};

const AUTOMATION_LABEL: Record<Automation, string> = {
  morning_brief: "Morning brief",
  call_analysis: "Call analysis",
  eow_report: "EOW report",
};

/**
 * A morning brief has three sources, a call analysis reads Slack + Granola, and an EOW report reads
 * HeyReach + Slack. So HeyReach and Granola are both optional here — a directory carries only the checks
 * its automation actually depends on.
 */
type ClientReadiness = { heyreach?: Check; slack: Check; granola?: Check; ready: boolean };

type BriefClient = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  accentColor: string | null;
  internalChannelId: string;
  externalChannelId: string;
  granolaTitleMatch: string;
  /** The morning brief's opt-in flag. Present on the brief directory only. */
  morningBriefEnabled?: boolean;
  /** The call analysis's opt-in flag. Present on the call-analysis directory only. */
  callAnalysisEnabled?: boolean;
  /** The EOW report's opt-in flag. Present on the eow-report directory only. */
  eowReportEnabled?: boolean;
  hasBrief?: boolean;
  readiness: ClientReadiness;
  sentToday: boolean;
  lastBriefAt: string | null;
  lastBriefStatus: string | null;
  lastBriefDestination: string | null;
  dueNow: boolean;
};

type Directory = {
  ok?: boolean;
  error?: string;
  slack: { configured: boolean; readable: boolean; readsAsUser: boolean; tokenEnv: string; userTokenEnv: string; testChannelId: string };
  anthropicConfigured: boolean;
  /** Absent on the EOW directory, which reads no call. */
  granolaKeyCount?: number;
  schedule: BriefSchedule;
  scheduleDueNow: boolean;
  workspaces: BriefClient[];
  due: string[];
};

type RunResult = {
  ok?: boolean;
  error?: string;
  brief?: string;
  /** id→name for the `<@U…>` codes in `brief`, so the website can render them as people. */
  mentions?: Record<string, string>;
  posted?: boolean;
  channelId?: string | null;
  channelNotes?: string[];
  /** The call the analysis read, so a manual run can show its date, who was on it, and how long it ran. */
  sources?: {
    call?: {
      title?: string;
      startedAt?: number;
      ageDays?: number;
      owner?: string;
      attendees?: string[];
      durationMinutes?: number;
      transcriptChars?: number;
    } | null;
  };
  /** Every request the run made, in order. Shown under the brief; see `briefTrace`. */
  steps?: TraceStep[];
};

/**
 * Where a manually run automation goes.
 *
 * A morning brief offers three: preview, the test channel, and the client's internal channel — the brief
 * is the team's own outstanding-work list, so its external channel is never a destination. A call
 * analysis offers a fourth, external, because a call summary is a thing a client is often glad to
 * receive. Which of the four are shown comes off the open automation, not off this type.
 */
type Destination = "preview" | "test" | "internal" | "external";

/** The zones the team actually works in. A free-text field here would be a typo away from a silent no-op. */
const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Jerusalem", "UTC"];

/**
 * When the last brief went, to the minute.
 *
 * The time matters as much as the day: three briefs a week go out at a set minute, so "Aug 18" cannot
 * distinguish one that arrived on schedule at 08:30 from one the worker got to at noon, and the second is a
 * thing to look into. Read in whoever is looking's own zone, which is the zone the clock on their wall is in.
 */
const formatWhen = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export default function SlackPage() {
  const [view, setView] = useState<"automations" | "clients" | "brief">("automations");
  const [automation, setAutomation] = useState<Automation>("morning_brief");
  // Both directories are held at once so the landing screen can show each automation's card without
  // opening it. `directory` below is whichever one is currently open.
  const [directories, setDirectories] = useState<Record<Automation, Directory | null>>({ morning_brief: null, call_analysis: null, eow_report: null });
  const [error, setError] = useState("");
  const [activeSlug, setActiveSlug] = useState("");
  const [destination, setDestination] = useState<Destination>("preview");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [draft, setDraft] = useState<BriefSchedule>(DEFAULT_SCHEDULE);
  const [savingSchedule, setSavingSchedule] = useState(false);
  /** Closed until asked for. The schedule is set once; the switch is the only part touched after that. */
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [togglingSlug, setTogglingSlug] = useState("");

  const directory = directories[automation];

  const load = async (which: Automation = automation) => {
    const payload = (await fetch(API[which], { cache: "no-store" }).then((response) => response.json()).catch(() => null)) as Directory | null;
    if (!payload || payload.ok === false || payload.error) {
      setError(payload?.error || "The client list could not be loaded.");
      return;
    }
    setError("");
    setDirectories((current) => ({ ...current, [which]: payload }));
    return payload;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Both automations up front, so the landing cards are populated and switching between them is
      // instant. The draft is seeded from whichever one is open, once, and then owned by the form.
      const [brief] = await Promise.all([load("morning_brief"), load("call_analysis"), load("eow_report")]);
      if (!cancelled && brief?.schedule) setDraft(brief.schedule);
    })();
    return () => { cancelled = true; };
  }, []);

  const clients = useMemo(() => directory?.workspaces ?? [], [directory]);
  const active = useMemo(() => clients.find((client) => client.slug === activeSlug) ?? null, [clients, activeSlug]);

  /** Whether this client is opted into whichever automation is open. */
  const isEnabled = (client: BriefClient) =>
    automation === "call_analysis"
      ? Boolean(client.callAnalysisEnabled)
      : automation === "eow_report"
        ? Boolean(client.eowReportEnabled)
        : Boolean(client.morningBriefEnabled);

  /** How many clients could actually receive this automation — every source, not just a channel. */
  const readyCount = clients.filter((client) => client.readiness?.ready).length;

  /** The destinations this automation offers, in the order they are shown. */
  const destinationsFor = (client: BriefClient | null): Array<[Destination, string, string]> => {
    const testChannelId = directory?.slack.testChannelId ?? "";
    const rows: Array<[Destination, string, string]> = [
      ["preview", "Show it here", "Nothing is posted"],
      ["test", "Test channel", testChannelId || "SLACK_TEST_CHANNEL_ID not set"],
      ["internal", "Internal channel", client?.internalChannelId || "No internal channel is set"],
    ];
    // Only the call analysis may post to the client's external channel; the brief never does.
    if (automation === "call_analysis") rows.push(["external", "External channel", client?.externalChannelId || "No external channel is set"]);
    return rows;
  };

  const openAutomation = (which: Automation) => {
    setAutomation(which);
    setScheduleOpen(false);
    setScheduleError("");
    const schedule = directories[which]?.schedule;
    if (schedule) setDraft(schedule);
    setView("clients");
  };

  const openClient = (slug: string) => {
    setActiveSlug(slug);
    setResult(null);
    setDestination("preview");
    setView("brief");
  };

  const saveSchedule = async (schedule: BriefSchedule = draft) => {
    setSavingSchedule(true);
    setScheduleError("");
    const response = await fetch(API[automation], { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ schedule }) }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    setSavingSchedule(false);
    if (!response?.ok || !payload?.ok) {
      setScheduleError(String(payload?.error || "The schedule could not be saved."));
      return;
    }
    await load();
  };

  /*
   * The switch saves on its own, unlike the fields behind the button.
   *
   * It has to: it is the only control still on the page when the editor is closed, and a switch that
   * looked on until the tab was reloaded would be read as "the brief is scheduled" when nothing had been
   * written down. The days and the time are edited in a batch and saved in one go, which is a different
   * act and keeps its own button.
   */
  const toggleSchedule = async () => {
    const next = { ...draft, enabled: !draft.enabled };
    setDraft(next);
    await saveSchedule(next);
  };

  const toggleClient = async (client: BriefClient) => {
    setTogglingSlug(client.slug);
    setScheduleError("");
    const response = await fetch(API[automation], { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace: client.slug, enabled: !isEnabled(client) }) }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    setTogglingSlug("");
    if (!response?.ok || !payload?.ok) {
      setScheduleError(String(payload?.error || "That client could not be updated."));
      return;
    }
    await load();
  };

  const runBrief = async () => {
    if (!active) return;
    setRunning(true);
    setResult(null);
    try {
      const response = await fetch(API[automation], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: active.slug, destination }),
      });
      const payload = (await response.json().catch(() => ({}))) as RunResult;
      setResult(payload);
      // The list carries "last brief" per client, and it is now wrong for this one. Re-read rather than
      // patch it locally: the row that was just written is the authority on when and whether.
      if (payload.brief) await load();
    } catch {
      setResult({ ok: false, error: "The brief could not be written." });
    } finally {
      setRunning(false);
    }
  };

  const logoOf = (client: BriefClient, className: string) => (
    <i className={className} style={client.logoUrl ? undefined : { background: client.accentColor || "var(--report-brand)" }} aria-hidden="true">
      {client.logoUrl ? <img src={client.logoUrl} alt="" /> : client.name.slice(0, 1).toUpperCase()}
    </i>
  );

  const testChannel = directory?.slack.testChannelId ?? "";
  const tokenEnv = directory?.slack.tokenEnv ?? "SLACK_BOT_TOKEN";
  const userTokenEnv = directory?.slack.userTokenEnv ?? "SLACK_USER_TOKEN";
  const toggleDay = (day: number) =>
    setDraft((current) => ({ ...current, sendDays: current.sendDays.includes(day) ? current.sendDays.filter((value) => value !== day) : [...current.sendDays, day].sort((a, b) => a - b) }));

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area reports-main">
        <header className="topbar">
          <Crumb trail={[{ label: "Slack" }]} />
          <div className="top-actions">
            <GlobalAppearanceControl />
          </div>
        </header>

        {view === "automations" ? (
          // `slack-hub` only scopes the card size below. `reports.css` is shared with the reports hub on
          // purpose, so a change made for one automation card must not resize a hub of twelve templates.
          <main className="reports-hub slack-hub">
            <div className="hub-lede"><h1>Slack</h1></div>

            <div className="hub-group-label">
              <span>Automations</span>
              <span>3 automations</span>
            </div>
            <div className="hub-card-grid">
              {(["morning_brief", "call_analysis", "eow_report"] as Automation[]).map((which) => {
                const dir = directories[which];
                return (
                  <div className="hub-card" key={which}>
                    <button type="button" className="hub-card-open" onClick={() => openAutomation(which)}>
                      <h3>{AUTOMATION_LABEL[which]}</h3>
                      <div className="hub-card-meta">
                        {/* The call analysis has no schedule — it runs the hour a new Granola call is found, so
                            showing a day/time for it would be a lie. The other two keep their schedule. */}
                        <b>{which === "call_analysis" ? "Runs when a call lands" : dir?.schedule.enabled ? describeSchedule(dir.schedule) : "Off"}</b>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Both of these are silent failures at run time, so they are said here instead. */}
            {directory && !directory.slack.readable && (
              <div className="hub-empty">No channel can be read. Set <code>{userTokenEnv}</code> to your own Slack user token, or <code>{tokenEnv}</code> and invite QC Bot to each channel.</div>
            )}
            {directory && !directory.slack.configured && (
              <div className="hub-empty">Nothing can be posted. Set <code>{tokenEnv}</code> so the brief arrives from QC Bot rather than from a person.</div>
            )}
            {directory && !directory.anthropicConfigured && (
              <div className="hub-empty">No <code>ANTHROPIC_API_KEY</code> is set, so no brief can be written.</div>
            )}
            {error && <div className="config-error">{error}</div>}
          </main>
        ) : view === "clients" ? (
          <main className="reports-hub">
            <button type="button" className="config-back" onClick={() => setView("automations")}>← Slack automations</button>
            <div className="hub-lede hub-lede-split">
              <h1>{AUTOMATION_LABEL[automation]}</h1>
              {/* The EOW report runs the built-in Tarsi template from the Reports hub, so there is no
                  AI-hub prompt to edit — the other two are written in the AI hub. */}
              {automation !== "eow_report" && (
                <a className="text-button" href={automation === "call_analysis" ? "/admin?section=ai-hub#ai-call-analysis" : "/admin?section=ai-hub#ai-morning-brief"}>Edit the prompt →</a>
              )}
            </div>

            {/* Call analysis has no schedule: it runs off the hourly Granola heartbeat, posting a recap
                the hour a new call is found. The morning brief still keeps its day/time schedule. */}
            {automation === "call_analysis" ? (
              <>
                <div className="hub-group-label">
                  <span>Trigger</span>
                  <span>Hourly Granola heartbeat</span>
                </div>
                <div className="brief-schedule">
                  <p className="brief-schedule-note">Polls every Granola key each hour, 5:00 AM – 8:00 PM Eastern. A new call is analysed and posted to the client&rsquo;s internal channel within the hour it is found. Enable a client below to include it.</p>
                </div>
              </>
            ) : (
              <>
                <div className="hub-group-label">
                  <span>Schedule</span>
                  <span>{describeSchedule(draft)}</span>
                </div>
                <div className="brief-schedule">
                  {/* The switch and one button. The days, the time and the zone are set once and then not
                      touched for months, and open on the page they were four controls standing between the
                      schedule and the client list, which is what somebody actually came here for. */}
                  <div className="brief-schedule-row">
                    <button type="button" className={draft.enabled ? "brief-switch is-on" : "brief-switch"} onClick={toggleSchedule} disabled={savingSchedule}>
                      <span />{draft.enabled ? "On" : "Off"}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => setScheduleOpen((open) => !open)}>
                      {scheduleOpen ? "Done" : "Edit time and date"}
                    </button>
                  </div>
                  {scheduleOpen && <div className="brief-schedule-row">
                    <div className="brief-days">
                      {DAY_NAMES.map((name, day) => (
                        <button key={name} type="button" className={draft.sendDays.includes(day) ? "brief-day is-on" : "brief-day"} onClick={() => toggleDay(day)} title={name}>
                          {name.slice(0, 1)}
                        </button>
                      ))}
                    </div>
                    <label className="brief-field">
                      TIME
                      <span className="brief-time">
                        <select value={draft.sendHour} onChange={(event) => setDraft((current) => ({ ...current, sendHour: Number(event.target.value) }))}>
                          {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}</option>)}
                        </select>
                        <select value={draft.sendMinute} onChange={(event) => setDraft((current) => ({ ...current, sendMinute: Number(event.target.value) }))}>
                          {[0, 15, 30, 45].map((minute) => <option key={minute} value={minute}>{String(minute).padStart(2, "0")}</option>)}
                        </select>
                      </span>
                    </label>
                    <label className="brief-field">
                      ZONE
                      <select value={draft.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))}>
                        {TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone.split("/").pop()?.replace(/_/g, " ")}</option>)}
                      </select>
                    </label>
                    <button className="config-generate" type="button" onClick={() => saveSchedule()} disabled={savingSchedule}>{savingSchedule ? "Saving…" : "Save schedule"}</button>
                  </div>}
                  {/* The one thing a schedule cannot show about itself: whether it would fire right now. */}
                  {directory?.scheduleDueNow && directory.schedule.enabled && (
                    <p className="brief-schedule-note">Due now. {directory.due.length ? `${directory.due.length} client${directory.due.length === 1 ? "" : "s"} waiting on the worker.` : "Every enabled client has had one today."}</p>
                  )}
                  {scheduleError && <div className="config-error">{scheduleError}</div>}
                </div>
              </>
            )}

            <div className="hub-group-label">
              <span>Clients</span>
              <span>{readyCount} of {clients.length} ready</span>
            </div>
            <ul className="brief-client-list">
              {clients.map((client) => {
                // HeyReach is a morning-brief source only; a call analysis reads Slack and Granola. So the
                // row shows two marks or three depending on which automation is open.
                const checks: Array<[string, { ok: boolean; detail: string }]> = [
                  ...(client.readiness.heyreach ? [["HeyReach", client.readiness.heyreach] as [string, { ok: boolean; detail: string }]] : []),
                  ["Slack", client.readiness.slack],
                  ...(client.readiness.granola ? [["Granola", client.readiness.granola] as [string, { ok: boolean; detail: string }]] : []),
                ];
                return (
                  <li key={client.slug} className={client.readiness.ready ? "brief-client" : "brief-client is-short"}>
                    <div className="brief-client-who">
                      {logoOf(client, "brief-client-logo")}
                      <div>
                        <strong>{client.name}</strong>
                        <small>{client.lastBriefAt ? `Last brief ${formatWhen(client.lastBriefAt)}` : "Never run"}{client.sentToday ? " · sent today" : ""}</small>
                      </div>
                    </div>
                    <div className="brief-client-checks">
                      {checks.map(([label, check]) => (
                        <span key={label} className={check.ok ? "brief-check is-ok" : "brief-check is-missing"} title={check.detail}>
                          <b>{check.ok ? "✓" : "✕"}</b>{label}<small>{check.detail}</small>
                        </span>
                      ))}
                    </div>
                    <div className="brief-client-channels">
                      <span className={client.internalChannelId ? "brief-channel" : "brief-channel is-missing"}>INT <code>{client.internalChannelId || "not set"}</code></span>
                      <span className={client.externalChannelId ? "brief-channel" : "brief-channel is-missing"}>EXT <code>{client.externalChannelId || "not set"}</code></span>
                    </div>
                    <div className="brief-client-actions">
                      {/* Not switchable while a source is missing. The toggle is a promise that Monday's
                          post is complete, and a half-sourced brief reads exactly like a whole one. */}
                      <button
                        type="button"
                        className={isEnabled(client) ? "brief-switch is-on" : "brief-switch"}
                        onClick={() => toggleClient(client)}
                        disabled={togglingSlug === client.slug || (!isEnabled(client) && !client.readiness.ready)}
                        title={client.readiness.ready ? "" : "Every source has to be working first."}
                      >
                        <span />{isEnabled(client) ? "On" : "Off"}
                      </button>
                      <button type="button" className="secondary-button" onClick={() => openClient(client.slug)}>Generate</button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {!clients.length && !error && <div className="hub-empty">No clients yet.</div>}
            {directory && automation !== "eow_report" && !directory.granolaKeyCount && (
              <div className="hub-empty">No Granola keys are stored, so no client&apos;s call can be read. <a href="/admin">Add one in configuration</a>.</div>
            )}
            {error && <div className="config-error">{error}</div>}
          </main>
        ) : (
          <main className="reports-hub">
            <button type="button" className="config-back" onClick={() => setView("clients")}>← All clients</button>
            {active && (
              <>
                <div className="hub-lede hub-lede-client">
                  {logoOf(active, "hub-lede-logo")}
                  <h1>{active.name}</h1>
                </div>

                <div className="hub-group-label"><span>Where it goes</span></div>
                {/* Preview first and selected by default, so the destination has to be chosen deliberately
                    to post anywhere. The internal channel is the real one; the test channel is for checking
                    a prompt change without putting it in front of the team. A call analysis adds external. */}
                <div className="slack-destinations">
                  {destinationsFor(active).map(([id, label, detail]) => {
                    const unavailable =
                      (id === "test" && !testChannel) ||
                      (id === "internal" && !active.internalChannelId) ||
                      (id === "external" && !active.externalChannelId);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`slack-destination${destination === id ? " is-active" : ""}`}
                        disabled={unavailable || running}
                        onClick={() => setDestination(id)}
                      >
                        <strong>{label}</strong>
                        <span>{detail}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="slack-run-row">
                  <button className="config-generate" onClick={runBrief} disabled={running}>
                    {running
                      ? (automation === "call_analysis" ? "Writing the analysis…" : automation === "eow_report" ? "Writing the report…" : "Writing the brief…")
                      : destination === "preview"
                        ? (automation === "call_analysis" ? "Write the analysis" : automation === "eow_report" ? "Write the report" : "Write the brief")
                        : "Write and post"}
                  </button>
                  <span className="slack-run-note">
                    {(() => {
                      // The morning brief has three sources, the call analysis two. Only list the ones this
                      // automation actually reads, and only the ones that are not working.
                      const sources: Array<[string, Check | undefined]> = [
                        ["campaign figures", active.readiness.heyreach],
                        ["Slack channels", active.readiness.slack],
                        ["the client's call", active.readiness.granola],
                      ];
                      const present = sources.filter(([, check]) => check);
                      const missing = present.filter(([, check]) => !check?.ok).map(([label]) => label);
                      return missing.length === 0
                        ? `All ${present.length === 2 ? "two" : "three"} sources are working.`
                        : `Missing: ${missing.join(", ")}.`;
                    })()}
                  </span>
                </div>

                {result?.error && <div className="config-error">{result.error}</div>}
                {result?.channelNotes?.map((note) => <div className="config-error" key={note}>{note}</div>)}

                {result?.brief && (
                  <>
                    <div className="hub-group-label">
                      <span>{automation === "call_analysis" ? "The analysis" : automation === "eow_report" ? "The report" : "The brief"}</span>
                      <span>{result.posted ? `Posted to ${result.channelId}` : "Not posted"}</span>
                    </div>
                    {/* Which meeting the recap read: the date it was on, who was there, how long it ran. Shown
                        only for a call analysis, and only when a call came back — a run with no call has no
                        metadata to name. `startedAt` is epoch millis from Granola. */}
                    {automation === "call_analysis" && result.sources?.call && (
                      <div className="call-meta">
                        {result.sources.call.startedAt ? <span>{new Date(result.sources.call.startedAt).toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric" })}</span> : null}
                        {result.sources.call.attendees?.length ? <span>{result.sources.call.attendees.join(", ")}</span> : null}
                        {typeof result.sources.call.durationMinutes === "number" ? <span>{result.sources.call.durationMinutes} min</span> : null}
                      </div>
                    )}
                    {/* On the website the result reads as a document: the stored Slack mrkdwn is parsed
                        back into headings and lists (BriefView), rather than shown as the raw markup Slack
                        itself receives. The mrkdwn is still what posts; this is only how it looks here. */}
                    <BriefView body={result.brief} mentions={result.mentions} />
                  </>
                )}

                {/* Under the brief, not above it: the brief is the answer and this is the working. The
                    excerpts are collapsed because each one is a wall of transcript, and open by default
                    they would bury the four lines that say which source came back thin. */}
                {result?.steps?.length ? (
                  <>
                    <div className="hub-group-label">
                      <span>What it did</span>
                      <span>{result.steps.length} steps</span>
                    </div>
                    <ol className="brief-trace">
                      {result.steps.map((step, index) => (
                        <li key={`${step.source}-${index}`} className={`brief-trace-step is-${step.state}`}>
                          <div className="brief-trace-head">
                            <b>{index + 1}</b>
                            <strong>{step.source}</strong>
                            <span>{step.result}</span>
                          </div>
                          {step.facts.length > 0 && (
                            <ul className="brief-trace-facts">
                              {step.facts.map((fact) => <li key={fact}>{fact}</li>)}
                            </ul>
                          )}
                          {step.excerpts.map((piece) => (
                            <details className="brief-trace-excerpt" key={piece.label}>
                              <summary>{piece.label} — {piece.chars.toLocaleString("en-US")} characters</summary>
                              <pre>{piece.text}</pre>
                            </details>
                          ))}
                        </li>
                      ))}
                    </ol>
                  </>
                ) : null}
              </>
            )}
          </main>
        )}
      </section>
    </div>
  );
}
