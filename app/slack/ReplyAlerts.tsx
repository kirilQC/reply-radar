// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useState } from "react";

/**
 * The Reply alerts automation on the Slack tab: per client, its replies channel, an on/off switch and a
 * test post. Reply alerts have no schedule (they fire when a lead replies), so this is its own view
 * rather than the scheduled automations' page. Saves go through the same client settings API that
 * Configuration uses, so the two can never disagree.
 */
type Client = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string;
  tone: string;
  channel: string;
  enabled: boolean;
  enabledAt: string | null;
  keyConfigured: boolean;
};

const fromRow = (row: Record<string, unknown>): Client => ({
  id: String(row.id ?? ""),
  name: String(row.name ?? ""),
  slug: String(row.slug ?? ""),
  logoUrl: String(row.logo_url ?? ""),
  tone: String(row.accent_color ?? "var(--report-brand)"),
  channel: String(row.slack_replies_channel_id ?? ""),
  enabled: row.reply_alerts_enabled === true,
  enabledAt: row.reply_alerts_enabled_at ? String(row.reply_alerts_enabled_at) : null,
  keyConfigured: Boolean(row.key_configured),
});

const since = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : "";

export default function ReplyAlerts({ onBack }: { onBack: () => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [channels, setChannels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const load = async () => {
    const payload = await fetch("/api/admin/workspaces", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (!payload?.workspaces) {
      setError("The client list could not be loaded.");
      setLoading(false);
      return;
    }
    const list = (payload.workspaces as Array<Record<string, unknown>>).map(fromRow);
    setClients(list);
    setChannels(Object.fromEntries(list.map((client) => [client.slug, client.channel])));
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const note = (slug: string, text: string) => setNotes((current) => ({ ...current, [slug]: text }));

  const save = async (client: Client, body: Record<string, unknown>) => {
    setBusy(client.slug);
    note(client.slug, "");
    const response = await fetch("/api/admin/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: client.id, previousSlug: client.slug, ...body }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy("");
    if (!response?.ok || payload?.ok === false) {
      note(client.slug, String(payload?.error || "Could not save."));
      return false;
    }
    await load();
    return true;
  };

  const saveChannel = async (client: Client) => {
    const value = (channels[client.slug] ?? "").trim();
    if (value === client.channel) return;
    // Clearing the channel also stops the alerts: there is nowhere left to post them.
    if (await save(client, { slackRepliesChannelId: value, ...(value ? {} : { replyAlertsEnabled: false }) })) note(client.slug, "Saved");
  };

  const toggle = (client: Client) => save(client, { replyAlertsEnabled: !client.enabled });

  const test = async (client: Client) => {
    setBusy(client.slug);
    note(client.slug, "");
    const response = await fetch("/api/slack/reply-alert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: true, workspaceId: client.id }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy("");
    note(client.slug, payload?.ok ? "Test posted to the test channel" : String(payload?.error || "Could not post the test."));
  };

  const ready = clients.filter((client) => client.channel && client.keyConfigured).length;
  const on = clients.filter((client) => client.enabled).length;

  return (
    <main className="reports-hub">
      <button type="button" className="config-back" onClick={onBack}>← Slack automations</button>
      <div className="hub-lede"><h1>Reply alerts</h1></div>

      <div className="hub-group-label">
        <span>Clients</span>
        <span>{on} on · {ready} of {clients.length} ready</span>
      </div>
      {loading ? (
        <div className="hub-empty">Loading…</div>
      ) : (
        <ul className="brief-client-list">
          {clients.map((client) => {
            const channel = channels[client.slug] ?? "";
            const isReady = Boolean(client.channel && client.keyConfigured);
            return (
              <li key={client.slug} className={isReady ? "brief-client" : "brief-client is-short"}>
                <div className="brief-client-who">
                  <i className="brief-client-logo" style={client.logoUrl ? undefined : { background: client.tone }} aria-hidden="true">
                    {client.logoUrl ? <img src={client.logoUrl} alt="" /> : client.name.slice(0, 1).toUpperCase()}
                  </i>
                  <div>
                    <strong>{client.name}</strong>
                    <small>{client.enabled ? `On since ${since(client.enabledAt)}` : "Off"}{notes[client.slug] ? ` · ${notes[client.slug]}` : ""}</small>
                  </div>
                </div>
                <div className="brief-client-checks">
                  <span className={client.keyConfigured ? "brief-check is-ok" : "brief-check is-missing"}>
                    <b>{client.keyConfigured ? "✓" : "✕"}</b>HeyReach<small>{client.keyConfigured ? "Key saved" : "No key"}</small>
                  </span>
                </div>
                <div className="brief-client-channels">
                  <label className={client.channel ? "brief-channel" : "brief-channel is-missing"}>
                    REPLIES
                    <input
                      className="reply-alert-channel"
                      value={channel}
                      placeholder="C09REPLIES"
                      onChange={(event) => setChannels((current) => ({ ...current, [client.slug]: event.target.value }))}
                      onBlur={() => void saveChannel(client)}
                      onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
                      disabled={busy === client.slug}
                    />
                  </label>
                </div>
                <div className="brief-client-actions">
                  <button
                    type="button"
                    className={client.enabled ? "brief-switch is-on" : "brief-switch"}
                    onClick={() => void toggle(client)}
                    disabled={busy === client.slug || (!client.enabled && !isReady)}
                    title={isReady ? "" : "Needs a replies channel and a HeyReach key."}
                  >
                    <span />{client.enabled ? "On" : "Off"}
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void test(client)} disabled={busy === client.slug}>Send a test</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="config-error">{error}</div>}
    </main>
  );
}
