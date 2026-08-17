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
 * ── The stylesheet is the reports one, deliberately ──────────────────────────────────────────────
 * `reports.css` carries `.client-grid`, `.hub-card` and the rest, and this hub is supposed to be the
 * same object. Importing it is what makes the two identical rather than merely similar — a second copy
 * of those rules would drift the first time either is touched.
 */

import { useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import "../reports/reports.css";

type BriefClient = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  accentColor: string | null;
  internalChannelId: string;
  externalChannelId: string;
  hasBrief: boolean;
  lastBriefAt: string | null;
  lastBriefStatus: string | null;
  lastBriefDestination: string | null;
};

type Directory = {
  ok?: boolean;
  error?: string;
  slack: { configured: boolean; tokenEnv: string; testChannelId: string };
  anthropicConfigured: boolean;
  workspaces: BriefClient[];
};

type RunResult = {
  ok?: boolean;
  error?: string;
  brief?: string;
  posted?: boolean;
  channelId?: string | null;
  channelNotes?: string[];
};

/** Where a brief goes. Not sent with the request until the button is pressed, so a misclick costs nothing. */
type Destination = "preview" | "test" | "internal";

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/slack/brief", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: Directory) => {
        if (cancelled) return;
        if (payload?.ok === false || payload?.error) { setError(payload.error || "The client list could not be loaded."); return; }
        setDirectory(payload);
      })
      .catch(() => { if (!cancelled) setError("The client list could not be loaded."); });
    return () => { cancelled = true; };
  }, []);

  const clients = directory?.workspaces ?? [];
  const active = useMemo(() => clients.find((client) => client.slug === activeSlug) ?? null, [clients, activeSlug]);

  /** How many clients could actually receive a brief today — the only number the card needs. */
  const readyCount = clients.filter((client) => client.internalChannelId || client.externalChannelId).length;
  const lastRunAt = clients
    .map((client) => client.lastBriefAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  const openClient = (slug: string) => {
    setActiveSlug(slug);
    setResult(null);
    setDestination("preview");
    setView("brief");
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
      if (payload.brief) {
        const refreshed = await fetch("/api/slack/brief", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
        if (refreshed?.workspaces) setDirectory(refreshed as Directory);
      }
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
                    {/* Two facts, not three: the card is 316px and a third wrapped the line. The window
                        is fixed at a week and never changes, so it is the one to lose. */}
                    <b>{lastRunAt ? `Last run ${formatWhen(lastRunAt)}` : "Never run"}</b>
                    <span>·</span>
                    <span>{readyCount === 1 ? "1 client ready" : `${readyCount} clients ready`}</span>
                  </div>
                </button>
              </div>
            </div>

            {/* Both of these are silent failures at run time, so they are said here instead. */}
            {directory && !directory.slack.configured && (
              <div className="hub-empty">Slack is not connected. Set <code>{tokenEnv}</code> and invite the Reply Radar bot to each channel.</div>
            )}
            {directory && !directory.anthropicConfigured && (
              <div className="hub-empty">No <code>ANTHROPIC_API_KEY</code> is set, so no brief can be written.</div>
            )}
            {error && <div className="config-error">{error}</div>}
          </main>
        ) : view === "clients" ? (
          <main className="reports-hub">
            <button type="button" className="config-back" onClick={() => setView("automations")}>← Slack automations</button>
            <div className="hub-lede"><h1>Morning brief</h1></div>

            <div className="hub-group-label">
              <span>Client workspaces</span>
              <span>{clients.length === 1 ? "1 client" : `${clients.length} clients`}</span>
            </div>
            <div className="client-grid">
              {clients.map((client) => {
                const channels = [client.internalChannelId, client.externalChannelId].filter(Boolean);
                return (
                  <button key={client.slug} type="button" className="client-card" onClick={() => openClient(client.slug)}>
                    {logoOf(client, "")}
                    <h3>{client.name}</h3>
                    {/* Whichever is the more useful of the two: when the last brief went out, or that
                        one cannot go out at all yet. */}
                    <small>{!channels.length ? "No channel set" : client.lastBriefAt ? `Last brief ${formatWhen(client.lastBriefAt)}` : "Never run"}</small>
                  </button>
                );
              })}
            </div>

            {!clients.length && !error && <div className="hub-empty">No clients yet.</div>}
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
                <div className="slack-destinations">
                  {([
                    ["preview", "Show it here", "Nothing is posted"],
                    ["test", "Test channel", testChannel || "SLACK_TEST_CHANNEL_ID not set"],
                    ["internal", "Internal channel", active.internalChannelId || "No channel set"],
                  ] as Array<[Destination, string, string]>).map(([id, label, detail]) => {
                    const unavailable = (id === "test" && !testChannel) || (id === "internal" && !active.internalChannelId);
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
                    {active.internalChannelId || active.externalChannelId
                      ? `Reads ${[active.internalChannelId ? "the internal channel" : "", active.externalChannelId ? "the external channel" : ""].filter(Boolean).join(" and ")}, plus this client's campaign figures.`
                      : "No Slack channel is set for this client, so the brief will only have the campaign figures."}
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
              </>
            )}
          </main>
        )}
      </section>
    </div>
  );
}
