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
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import { DAY_NAMES, DEFAULT_SCHEDULE, describeSchedule, type BriefSchedule, type Readiness } from "../lib/morning-brief-schedule";
import type { TraceStep } from "../lib/morning-brief";
import "../reports/reports.css";

type BriefClient = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  accentColor: string | null;
  internalChannelId: string;
  externalChannelId: string;
  granolaTitleMatch: string;
  morningBriefEnabled: boolean;
  hasBrief: boolean;
  readiness: Readiness;
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
  granolaKeyCount: number;
  schedule: BriefSchedule;
  scheduleDueNow: boolean;
  workspaces: BriefClient[];
  due: string[];
};

type RunResult = {
  ok?: boolean;
  error?: string;
  brief?: string;
  posted?: boolean;
  channelId?: string | null;
  channelNotes?: string[];
  /** Every request the run made, in order. Shown under the brief; see `briefTrace`. */
  steps?: TraceStep[];
};

/**
 * Where a manually run brief goes. Not sent with the request until the button is pressed, so a misclick
 * costs nothing — and neither of the two can reach a client, so the worst a right click can do is post to
 * the test channel. The scheduled run posts to the client's internal channel and is not chosen here.
 */
type Destination = "preview" | "test";

/** The zones the team actually works in. A free-text field here would be a typo away from a silent no-op. */
const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Jerusalem", "UTC"];

const formatWhen = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export default function SlackPage() {
  const [view, setView] = useState<"automations" | "clients" | "brief">("automations");
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [activeSlug, setActiveSlug] = useState("");
  const [destination, setDestination] = useState<Destination>("preview");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [draft, setDraft] = useState<BriefSchedule>(DEFAULT_SCHEDULE);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [togglingSlug, setTogglingSlug] = useState("");

  const load = async () => {
    const payload = (await fetch("/api/slack/brief", { cache: "no-store" }).then((response) => response.json()).catch(() => null)) as Directory | null;
    if (!payload || payload.ok === false || payload.error) {
      setError(payload?.error || "The client list could not be loaded.");
      return;
    }
    setError("");
    setDirectory(payload);
    return payload;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const payload = await load();
      // The draft is seeded once from the server and then owned by the form. Re-seeding on every reload
      // would throw away half-made edits the moment a brief finished writing in another part of the page.
      if (!cancelled && payload?.schedule) setDraft(payload.schedule);
    })();
    return () => { cancelled = true; };
  }, []);

  const clients = directory?.workspaces ?? [];
  const active = useMemo(() => clients.find((client) => client.slug === activeSlug) ?? null, [clients, activeSlug]);

  /** How many clients could actually receive a brief — all three sources, not just a channel. */
  const readyCount = clients.filter((client) => client.readiness?.ready).length;
  const enabledCount = clients.filter((client) => client.morningBriefEnabled).length;

  const openClient = (slug: string) => {
    setActiveSlug(slug);
    setResult(null);
    setDestination("preview");
    setView("brief");
  };

  const saveSchedule = async () => {
    setSavingSchedule(true);
    setScheduleError("");
    const response = await fetch("/api/slack/brief", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ schedule: draft }) }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    setSavingSchedule(false);
    if (!response?.ok || !payload?.ok) {
      setScheduleError(String(payload?.error || "The schedule could not be saved."));
      return;
    }
    await load();
  };

  const toggleClient = async (client: BriefClient) => {
    setTogglingSlug(client.slug);
    setScheduleError("");
    const response = await fetch("/api/slack/brief", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace: client.slug, enabled: !client.morningBriefEnabled }) }).catch(() => null);
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
      const response = await fetch("/api/slack/brief", {
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
          <main className="reports-hub">
            <div className="hub-lede"><h1>Slack</h1></div>

            <div className="hub-group-label">
              <span>Automations</span>
              <span>1 automation</span>
            </div>
            <div className="hub-card-grid">
              <div className="hub-card">
                <button type="button" className="hub-card-open" onClick={() => setView("clients")}>
                  <h3>Morning brief</h3>
                  <div className="hub-card-meta">
                    {/* Three facts fit only because the schedule is the shortest of them when it is off. */}
                    <b>{directory?.schedule.enabled ? describeSchedule(directory.schedule) : "Off"}</b>
                    <span>·</span>
                    <span>{enabledCount === 1 ? "1 client on" : `${enabledCount} clients on`}</span>
                  </div>
                </button>
              </div>
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
              <h1>Morning brief</h1>
              <a className="text-button" href="/admin?section=ai-hub#ai-morning-brief">Edit the prompt →</a>
            </div>

            <div className="hub-group-label">
              <span>Schedule</span>
              <span>{describeSchedule(draft)}</span>
            </div>
            <div className="brief-schedule">
              <div className="brief-schedule-row">
                <button type="button" className={draft.enabled ? "brief-switch is-on" : "brief-switch"} onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}>
                  <span />{draft.enabled ? "On" : "Off"}
                </button>
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
                {/* No destination picker. A scheduled brief goes to the client's internal channel, which
                    is the only place it was ever for — the field only existed to be got wrong. */}
                <button className="config-generate" type="button" onClick={saveSchedule} disabled={savingSchedule}>{savingSchedule ? "Saving…" : "Save schedule"}</button>
              </div>
              {/* The one thing a schedule cannot show about itself: whether it would fire right now. */}
              {directory?.scheduleDueNow && directory.schedule.enabled && (
                <p className="brief-schedule-note">Due now. {directory.due.length ? `${directory.due.length} client${directory.due.length === 1 ? "" : "s"} waiting on the worker.` : "Every enabled client has had one today."}</p>
              )}
              {scheduleError && <div className="config-error">{scheduleError}</div>}
            </div>

            <div className="hub-group-label">
              <span>Clients</span>
              <span>{readyCount} of {clients.length} ready</span>
            </div>
            <ul className="brief-client-list">
              {clients.map((client) => {
                const checks: Array<[string, { ok: boolean; detail: string }]> = [
                  ["HeyReach", client.readiness.heyreach],
                  ["Slack", client.readiness.slack],
                  ["Granola", client.readiness.granola],
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
                        className={client.morningBriefEnabled ? "brief-switch is-on" : "brief-switch"}
                        onClick={() => toggleClient(client)}
                        disabled={togglingSlug === client.slug || (!client.morningBriefEnabled && !client.readiness.ready)}
                        title={client.readiness.ready ? "" : "All three sources have to be working first."}
                      >
                        <span />{client.morningBriefEnabled ? "On" : "Off"}
                      </button>
                      <button type="button" className="secondary-button" onClick={() => openClient(client.slug)}>Generate</button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {!clients.length && !error && <div className="hub-empty">No clients yet.</div>}
            {directory && !directory.granolaKeyCount && (
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
                {/* Two, not four. Clicking Generate by hand is checking the prompt, and the scheduled run
                    is what posts to the team — so a manual run either shows the brief here or drops it in
                    the test channel. Neither can reach a client. */}
                <div className="slack-destinations">
                  {([
                    ["preview", "Show it here", "Nothing is posted"],
                    ["test", "Test channel", testChannel || "SLACK_TEST_CHANNEL_ID not set"],
                  ] as Array<[Destination, string, string]>).map(([id, label, detail]) => {
                    const unavailable = id === "test" && !testChannel;
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
                    {running ? "Writing the brief…" : destination === "preview" ? "Write the brief" : "Write and post"}
                  </button>
                  <span className="slack-run-note">
                    {[active.readiness.heyreach, active.readiness.slack, active.readiness.granola].filter((check) => !check.ok).length === 0
                      ? "All three sources are working."
                      : `Missing: ${[["campaign figures", active.readiness.heyreach], ["Slack channels", active.readiness.slack], ["the client's call", active.readiness.granola]].filter(([, check]) => !(check as { ok: boolean }).ok).map(([label]) => label).join(", ")}.`}
                  </span>
                </div>

                {result?.error && <div className="config-error">{result.error}</div>}
                {result?.channelNotes?.map((note) => <div className="config-error" key={note}>{note}</div>)}

                {result?.brief && (
                  <>
                    <div className="hub-group-label">
                      <span>The brief</span>
                      <span>{result.posted ? `Posted to ${result.channelId}` : "Not posted"}</span>
                    </div>
                    {/* Shown exactly as Slack will render the text, which is to say not rendered at all:
                        a preview that prettified the mrkdwn would hide the one thing worth checking. */}
                    <pre className="slack-brief-body">{result.brief}</pre>
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
