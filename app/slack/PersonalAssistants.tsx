// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import { DAY_NAMES, describeSchedule, type BriefSchedule } from "../lib/morning-brief-schedule";

type Client = { id: string; name: string; slug: string; logoUrl: string | null };
type Person = {
  id: string; personName: string; slackUserId: string; clientSlugs: string[];
  enabled: boolean; sendDays: number[]; sendHour: number; sendMinute: number; timezone: string; lastSentAt: string | null;
};
type Draft = Omit<Person, "lastSentAt">;

const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Asia/Jerusalem"];

const NEW_DRAFT: Draft = { id: "", personName: "", slackUserId: "", clientSlugs: [], enabled: true, sendDays: [1, 2, 3, 4, 5], sendHour: 8, sendMinute: 0, timezone: "America/New_York" };

const scheduleOf = (d: { enabled: boolean; sendDays: number[]; sendHour: number; sendMinute: number; timezone: string }): BriefSchedule =>
  ({ enabled: d.enabled, sendDays: d.sendDays, sendHour: d.sendHour, sendMinute: d.sendMinute, timezone: d.timezone, destination: "dm" });

export default function PersonalAssistants({ onBack }: { onBack: () => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = async () => {
    try {
      const payload = await fetch("/api/slack/personal", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
      if (payload?.ok) {
        setPeople(Array.isArray(payload.people) ? payload.people : []);
        setClients(Array.isArray(payload.clients) ? payload.clients : []);
      } else setError(payload?.error || "Could not load personal assistants.");
    } catch { setError("Could not reach the server."); }
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const clientName = (slug: string) => clients.find((c) => c.slug === slug)?.name || slug;

  const save = async () => {
    if (!editing || saving) return;
    if (!editing.personName.trim()) { setError("Add a name."); return; }
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/slack/personal", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ assistant: editing }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setError(payload?.error || "Could not save."); setSaving(false); return; }
      setEditing(null); setSaving(false); await load();
    } catch { setError("Could not reach the server."); setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this personal assistant?")) return;
    setBusy(id);
    await fetch("/api/slack/personal", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: { id } }) }).catch(() => {});
    setBusy(""); await load();
  };

  const sendNow = async (id: string) => {
    setBusy(id); setNote(""); setError("");
    try {
      const response = await fetch("/api/slack/personal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.ok) setNote(`Sent — pulled together ${Array.isArray(payload.clients) ? payload.clients.length : 0} client${(payload.clients?.length ?? 0) === 1 ? "" : "s"}.`);
      else setError(payload?.error || "Could not send.");
    } catch { setError("Could not reach the server."); }
    setBusy(""); await load();
  };

  const toggleEnabled = async (p: Person) => {
    setBusy(p.id);
    await fetch("/api/slack/personal", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assistant: { id: p.id, personName: p.personName, slackUserId: p.slackUserId, clientSlugs: p.clientSlugs, enabled: !p.enabled, sendDays: p.sendDays, sendHour: p.sendHour, sendMinute: p.sendMinute, timezone: p.timezone } }),
    }).catch(() => {});
    setBusy(""); await load();
  };

  // ── Editor ──────────────────────────────────────────────────────────────────────────────────────
  if (editing) {
    const d = editing;
    const set = (patch: Partial<Draft>) => setEditing((cur) => (cur ? { ...cur, ...patch } : cur));
    const toggleDay = (day: number) => set({ sendDays: d.sendDays.includes(day) ? d.sendDays.filter((x) => x !== day) : [...d.sendDays, day].sort() });
    const toggleClient = (slug: string) => set({ clientSlugs: d.clientSlugs.includes(slug) ? d.clientSlugs.filter((s) => s !== slug) : [...d.clientSlugs, slug] });
    return (
      <main className="reports-hub">
        <button type="button" className="config-back" onClick={() => setEditing(null)}>← Personal assistants</button>
        <div className="hub-lede"><h1>{d.id ? "Edit assistant" : "New personal assistant"}</h1></div>

        <div className="pa-form">
          <div className="pa-field-row">
            <label className="brief-field">NAME
              <input value={d.personName} placeholder="Kiril Ivlev" onChange={(e) => set({ personName: e.target.value })} />
            </label>
            <label className="brief-field">SLACK USER ID
              <input value={d.slackUserId} placeholder="U01ABCDEF" onChange={(e) => set({ slackUserId: e.target.value.trim() })} />
            </label>
          </div>
          <p className="brief-schedule-note">The bot DMs this person at their Slack member ID (Slack profile → ⋮ → Copy member ID). It needs the bot&apos;s <code>im:write</code> scope.</p>

          <div className="hub-group-label"><span>Clients to track</span><span>{d.clientSlugs.length} selected</span></div>
          <div className="pa-clients">
            {clients.map((c) => (
              <button type="button" key={c.slug} className={`pa-client ${d.clientSlugs.includes(c.slug) ? "is-on" : ""}`} onClick={() => toggleClient(c.slug)}>
                {c.name}
              </button>
            ))}
            {clients.length === 0 && <span className="brief-schedule-note">No clients found.</span>}
          </div>

          <div className="hub-group-label"><span>Schedule</span><span>{describeSchedule(scheduleOf(d))}</span></div>
          <div className="brief-schedule">
            <div className="brief-schedule-row">
              <button type="button" className={d.enabled ? "brief-switch is-on" : "brief-switch"} onClick={() => set({ enabled: !d.enabled })}><span />{d.enabled ? "On" : "Off"}</button>
            </div>
            <div className="brief-schedule-row">
              <div className="brief-days">
                {DAY_NAMES.map((name, day) => (
                  <button type="button" key={day} className={d.sendDays.includes(day) ? "brief-day is-on" : "brief-day"} onClick={() => toggleDay(day)} title={name}>{name.slice(0, 1)}</button>
                ))}
              </div>
              <label className="brief-field">TIME
                <span className="brief-time">
                  <select value={d.sendHour} onChange={(e) => set({ sendHour: Number(e.target.value) })}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}</option>)}
                  </select>
                  <select value={d.sendMinute} onChange={(e) => set({ sendMinute: Number(e.target.value) })}>
                    {[0, 15, 30, 45].map((m) => <option key={m} value={m}>{String(m).padStart(2, "0")}</option>)}
                  </select>
                </span>
              </label>
              <label className="brief-field">ZONE
                <select value={d.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>)}
                </select>
              </label>
            </div>
          </div>

          {error && <div className="config-error">{error}</div>}
          <div className="pa-form-actions">
            <button type="button" className="config-generate" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : d.id ? "Save changes" : "Create assistant"}</button>
          </div>
        </div>
      </main>
    );
  }

  // ── Roster ──────────────────────────────────────────────────────────────────────────────────────
  return (
    <main className="reports-hub">
      <button type="button" className="config-back" onClick={onBack}>← Slack automations</button>
      <div className="hub-lede"><h1>Personal assistant</h1><p>A per-person morning brief, DM&apos;d to each teammate across the clients they own.</p></div>

      <div className="hub-group-label"><span>Team</span><span>{people.length} {people.length === 1 ? "person" : "people"}</span></div>
      {note && <div className="pa-note">{note}</div>}
      {error && <div className="config-error">{error}</div>}

      {loading ? <p className="brief-schedule-note">Loading…</p> : (
        <div className="pa-list">
          {people.map((p) => (
            <div className="pa-card" key={p.id}>
              <div className="pa-card-head">
                <div className="pa-card-who">
                  <strong>{p.personName}</strong>
                  <span className="pa-card-sub">{p.slackUserId ? `DM ${p.slackUserId}` : "No Slack ID set"} · {p.clientSlugs.length} client{p.clientSlugs.length === 1 ? "" : "s"} · {p.enabled ? describeSchedule(scheduleOf(p)) : "Off"}</span>
                </div>
                <button type="button" className={p.enabled ? "brief-switch is-on" : "brief-switch"} onClick={() => void toggleEnabled(p)} disabled={busy === p.id}><span />{p.enabled ? "On" : "Off"}</button>
              </div>
              {p.clientSlugs.length > 0 && (
                <div className="pa-card-clients">
                  {p.clientSlugs.map((slug) => <span className="pa-tag" key={slug}>{clientName(slug)}</span>)}
                </div>
              )}
              <div className="pa-card-actions">
                <button type="button" className="secondary-button" onClick={() => void sendNow(p.id)} disabled={busy === p.id}>{busy === p.id ? "Working…" : "Send now"}</button>
                <button type="button" className="secondary-button" onClick={() => setEditing({ id: p.id, personName: p.personName, slackUserId: p.slackUserId, clientSlugs: p.clientSlugs, enabled: p.enabled, sendDays: p.sendDays, sendHour: p.sendHour, sendMinute: p.sendMinute, timezone: p.timezone })}>Edit</button>
                <button type="button" className="pa-delete" onClick={() => void remove(p.id)} disabled={busy === p.id}>Delete</button>
              </div>
            </div>
          ))}
          <button type="button" className="pa-add" onClick={() => setEditing({ ...NEW_DRAFT })}>+ Add person</button>
        </div>
      )}
    </main>
  );
}
