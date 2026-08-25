// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import "../../meetings.css";

type Meeting = {
  id: string;
  inviteeName: string | null;
  inviteeEmail: string | null;
  inviteeLinkedin: string | null;
  inviteeTitle: string | null;
  inviteeLocation: string | null;
  inviteeHeadline: string | null;
  inviteePhotoUrl: string | null;
  companyName: string | null;
  companyDomain: string | null;
  companyLinkedin: string | null;
  companyLocation: string | null;
  companyIndustry: string | null;
  companySize: string | null;
  companyType: string | null;
  companyDescription: string | null;
  companyLogoUrl: string | null;
  meetingAt: string | null;
  whenText: string | null;
  summary: string | null;
  host: string | null;
  campaign: string | null;
  status: string;
  source: string;
  createdAt: string;
};
type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };
type ThreadMessage = { direction: string; body: string; sentAt: string | null };
type History = { loading: boolean; found: boolean; messages: ThreadMessage[] };

const FIELDS = [
  ["invitee_name", "Name"],
  ["invitee_email", "Email"],
  ["invitee_title", "Title"],
  ["company_name", "Company"],
  ["invitee_linkedin", "LinkedIn"],
  ["summary", "Summary"],
  ["host", "Meeting with"],
  ["campaign", "Campaign"],
] as const;

const initialsOf = (value: string | null) =>
  (value || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

const isEnriched = (m: Meeting) =>
  Boolean(m.inviteeLocation || m.inviteeHeadline || m.inviteePhotoUrl || m.companyDomain || m.companyIndustry || m.companyDescription);

/** A photo when we have one, initials when we do not. */
function Avatar({ src, name, className }: { src: string | null; name: string | null; className: string }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) return <img className={`${className} is-photo`} src={src} alt="" onError={() => setBroken(true)} />;
  return <span className={className}>{initialsOf(name)}</span>;
}

/** The short date/time shown on the left rail of each row. */
function whenParts(meeting: Meeting): { top: string; bottom: string; tbd: boolean } {
  if (meeting.meetingAt) {
    const date = new Date(meeting.meetingAt);
    if (!Number.isNaN(date.getTime())) {
      return {
        top: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        bottom: date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + " · " + date.getFullYear(),
        tbd: false,
      };
    }
  }
  return { top: meeting.whenText ? meeting.whenText.slice(0, 16) : "TBD", bottom: "", tbd: true };
}

/** The full, human date used inside the expanded detail. */
function fullWhen(meeting: Meeting): string {
  if (meeting.meetingAt) {
    const date = new Date(meeting.meetingAt);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric", year: "numeric" }) +
        " · " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
  }
  return meeting.whenText || "Time to be confirmed";
}

function messageTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function ConversationHistory({ history, leadName }: { history: History | undefined; leadName: string | null }) {
  if (!history || history.loading) return <div className="mtg-history-note">Looking for a prior conversation…</div>;
  if (!history.found) return <div className="mtg-history-note">This person is not a lead in the database yet, so there is no conversation on file.</div>;
  if (history.messages.length === 0) return <div className="mtg-history-note">They are a lead we contacted, but no messages have been stored yet.</div>;
  return (
    <div className="mtg-thread">
      {history.messages.map((message, index) => {
        const outbound = message.direction === "outbound";
        return (
          <div className={`mtg-msg ${outbound ? "out" : "in"}`} key={index}>
            <div className="mtg-msg-meta">
              <span>{outbound ? "QC" : leadName || "Lead"}</span>
              {messageTime(message.sentAt) && <span className="mtg-msg-time">{messageTime(message.sentAt)}</span>}
            </div>
            <div className="mtg-msg-body">{message.body}</div>
          </div>
        );
      })}
    </div>
  );
}

function Detail({ meeting, history, onDelete, onEnrich, enriching }: { meeting: Meeting; history: History | undefined; onDelete: () => void; onEnrich: () => void; enriching: boolean }) {
  const leadRows: Array<[string, string | null, "link" | "email" | "text"]> = [
    ["Email", meeting.inviteeEmail, "email"],
    ["LinkedIn", meeting.inviteeLinkedin, "link"],
    ["Location", meeting.inviteeLocation, "text"],
    ["Headline", meeting.inviteeHeadline, "text"],
  ];
  const companyRows: Array<[string, string | null, "link" | "text"]> = [
    ["Domain", meeting.companyDomain, "link"],
    ["LinkedIn", meeting.companyLinkedin, "link"],
    ["Location", meeting.companyLocation, "text"],
    ["Industry", meeting.companyIndustry, "text"],
    ["Size", meeting.companySize, "text"],
    ["Type", meeting.companyType, "text"],
  ];
  const cell = (value: string | null, kind: "link" | "email" | "text") => {
    if (!value) return <span className="mtg-empty-cell">—</span>;
    if (kind === "email") return <a href={`mailto:${value}`}>{value}</a>;
    if (kind === "link") {
      const href = value.startsWith("http") ? value : `https://${value}`;
      return <a href={href} target="_blank" rel="noreferrer">{value}</a>;
    }
    return <span>{value}</span>;
  };
  const companyLogo = meeting.companyLogoUrl || (meeting.companyDomain ? `https://logo.clearbit.com/${meeting.companyDomain}` : null);
  const facts: Array<[string, string | null]> = [
    ["When", fullWhen(meeting)],
    ["Meeting with", meeting.host],
    ["Campaign", meeting.campaign],
  ];

  return (
    <div className="mtg-detail">
      <div className="mtg-identity">
        <Avatar src={meeting.inviteePhotoUrl} name={meeting.inviteeName || meeting.inviteeEmail} className="mtg-avatar" />
        <div className="mtg-identity-main">
          <strong>{meeting.inviteeName || meeting.inviteeEmail || "Unnamed invitee"}</strong>
          <span className="mtg-identity-sub">{[meeting.inviteeTitle, meeting.companyName].filter(Boolean).join(" · ") || "Role and company not recorded"}</span>
          {meeting.inviteeHeadline && <span className="mtg-identity-headline">{meeting.inviteeHeadline}</span>}
        </div>
        <div className="mtg-identity-facts">
          {facts.filter(([, v]) => v).map(([label, value]) => (
            <div className="mtg-fact" key={label}><span>{label}</span><b>{value}</b></div>
          ))}
        </div>
      </div>

      <div className="mtg-cards">
        <div className="mtg-card-panel">
          <h4>Lead</h4>
          {leadRows.map(([label, value, kind]) => (
            <div className="mtg-field" key={label}><b>{label}</b>{cell(value, kind)}</div>
          ))}
        </div>
        <div className="mtg-card-panel">
          <div className="mtg-panel-head">
            <div className="mtg-panel-title">
              {companyLogo && <img className="mtg-company-logo" src={companyLogo} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
              <h4>{meeting.companyName || "Company"}</h4>
            </div>
          </div>
          {companyRows.map(([label, value, kind]) => (
            <div className="mtg-field" key={label}><b>{label}</b>{cell(value, kind)}</div>
          ))}
        </div>
      </div>

      {meeting.companyDescription && (
        <div className="mtg-prose">
          <h4>About {meeting.companyName || "the company"}</h4>
          <p>{meeting.companyDescription}</p>
        </div>
      )}
      {meeting.summary && (
        <div className="mtg-prose">
          <h4>Meeting notes</h4>
          <p>{meeting.summary}</p>
        </div>
      )}

      <div className="mtg-prose mtg-history">
        <h4>Conversation history</h4>
        <ConversationHistory history={history} leadName={meeting.inviteeName} />
      </div>

      <div className="mtg-detail-actions">
        <button className="mtg-enrich" onClick={onEnrich} disabled={enriching}>{enriching ? "Enriching…" : "↻ Re-enrich"}</button>
        <button className="mtg-delete" onClick={onDelete}>Delete meeting</button>
      </div>
    </div>
  );
}

export default function ClientMeetingsPage() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<Client | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [meetingAt, setMeetingAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [enriching, setEnriching] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, History>>({});
  const [error, setError] = useState("");
  const autoEnriched = useRef<Set<string>>(new Set());
  // Captured once so the "upcoming" count is computed from a stable clock rather than reading the wall clock
  // during render (which the compiler rejects as impure); a minute's drift never matters for a count.
  const [now] = useState(() => Date.now());

  const load = async () => {
    try {
      const response = await fetch(`/api/meetings/clients/${encodeURIComponent(slug)}`, { cache: "no-store" });
      if (response.status === 404) { setNotFound(true); setLoading(false); return; }
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.client) {
        setClient(payload.client);
        setMeetings(Array.isArray(payload.meetings) ? payload.meetings : []);
      }
    } catch { /* leave loading */ }
    setLoading(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads slug; re-running only on slug is intended.
  useEffect(() => { if (slug) void load(); }, [slug]);

  // Auto-enrich: any meeting that arrived without enrichment (an older row, or a webhook whose background
  // enrichment has not landed yet) is enriched the moment it is on screen, once. The ref guards against
  // re-firing for the same meeting when state updates.
  useEffect(() => {
    const pending = meetings.filter((m) => m.inviteeLinkedin && !isEnriched(m) && !autoEnriched.current.has(m.id));
    if (!pending.length) return;
    pending.forEach((m) => autoEnriched.current.add(m.id));
    void Promise.all(pending.map(async (m) => {
      try {
        const response = await fetch(`/api/meetings/enrich`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meetingId: m.id }) });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload.meeting) setMeetings((list) => list.map((x) => (x.id === m.id ? payload.meeting : x)));
      } catch { /* leave the meeting as-is */ }
    }));
  }, [meetings]);

  const loadHistory = async (id: string) => {
    setHistory((h) => ({ ...h, [id]: { loading: true, found: false, messages: [] } }));
    try {
      const response = await fetch(`/api/meetings/history`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meetingId: id }) });
      const payload = await response.json().catch(() => ({}));
      setHistory((h) => ({ ...h, [id]: { loading: false, found: Boolean(payload.found), messages: Array.isArray(payload.messages) ? payload.messages : [] } }));
    } catch {
      setHistory((h) => ({ ...h, [id]: { loading: false, found: false, messages: [] } }));
    }
  };

  const toggle = (id: string) => {
    const opening = open !== id;
    setOpen(opening ? id : null);
    if (opening && !history[id]) void loadHistory(id);
  };

  const save = async () => {
    if (saving) return;
    const body: Record<string, unknown> = { ...form };
    if (meetingAt) body.meeting_at = meetingAt;
    if (!String(body.invitee_name ?? "").trim() && !String(body.invitee_email ?? "").trim() && !String(body.company_name ?? "").trim()) {
      setError("Add at least a name, email or company.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/meetings/clients/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setError(typeof payload.error === "string" ? payload.error : "Could not save."); setSaving(false); return; }
      setForm({});
      setMeetingAt("");
      setAdding(false);
      setSaving(false);
      await load();
    } catch {
      setError("Could not reach the server.");
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this meeting?")) return;
    await fetch(`/api/meetings/clients/${encodeURIComponent(slug)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
    await load();
  };

  const enrichOne = async (id: string) => {
    if (enriching) return;
    setEnriching(id);
    try {
      const response = await fetch(`/api/meetings/enrich`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meetingId: id }) });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.meeting) setMeetings((list) => list.map((m) => (m.id === id ? payload.meeting : m)));
    } finally {
      setEnriching(null);
    }
  };

  const upcoming = meetings.filter((m) => m.meetingAt && new Date(m.meetingAt).getTime() >= now && m.status !== "canceled").length;

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Meetings", href: "/meetings" }, { label: client?.name || "Client" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="mtg-shell mtg-shell-wide">
          {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading meetings…</p>}
          {notFound && !loading && <div className="mtg-empty">That client was not found. <Link href="/meetings" style={{ color: "var(--accent)" }}>Back</Link>.</div>}

          {client && (
            <>
              <div className="mtg-client-head">
                <span className="mtg-client-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
                  {client.logoUrl ? <img src={client.logoUrl} alt="" /> : (client.name[0] || "?").toUpperCase()}
                </span>
                <div className="mtg-client-titles">
                  <h1>{client.name}</h1>
                  <div className="mtg-head-meta">
                    <Link href="/meetings" className="mtg-back">← All clients</Link>
                    <span className="mtg-head-count">{meetings.length} booked{upcoming ? ` · ${upcoming} upcoming` : ""}</span>
                  </div>
                </div>
                <button className="primary-button" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "Add meeting"}</button>
              </div>

              {adding && (
                <div className="mtg-add">
                  {FIELDS.map(([key, label]) => (
                    <div className={`mtg-field-input${key === "summary" || key === "campaign" ? " wide" : ""}`} key={key}>
                      <label htmlFor={`f-${key}`}>{label}</label>
                      <input id={`f-${key}`} value={form[key] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
                    </div>
                  ))}
                  <div className="mtg-field-input">
                    <label htmlFor="f-when">When</label>
                    <input id="f-when" type="datetime-local" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} />
                  </div>
                  <div className="mtg-add-actions">
                    <button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save meeting"}</button>
                    {error && <span className="mtg-error">{error}</span>}
                  </div>
                </div>
              )}

              {meetings.length === 0 && !adding && <div className="mtg-empty">No meetings yet. They arrive from the Calendly webhook, or add one by hand.</div>}

              <div className="mtg-list">
                {meetings.map((meeting) => {
                  const when = whenParts(meeting);
                  const expanded = open === meeting.id;
                  const enriched = isEnriched(meeting);
                  return (
                    <div className={`mtg-item ${expanded ? "open" : ""}`} key={meeting.id}>
                      <div className="mtg-item-head" onClick={() => toggle(meeting.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") toggle(meeting.id); }}>
                        <div className={`mtg-when ${when.tbd ? "tbd" : ""}`}>
                          <b>{when.top}</b>
                          {when.bottom && <span>{when.bottom}</span>}
                        </div>
                        <Avatar src={meeting.inviteePhotoUrl} name={meeting.inviteeName || meeting.inviteeEmail} className="mtg-row-avatar" />
                        <div className="mtg-who">
                          <strong>{meeting.inviteeName || meeting.inviteeEmail || "Unnamed invitee"}</strong>
                          <span className="mtg-sub">{[meeting.inviteeTitle, meeting.companyName].filter(Boolean).join(" · ") || "—"}</span>
                          <div className="mtg-meta">
                            {meeting.campaign && <span className="mtg-chip">{meeting.campaign}</span>}
                            {meeting.host && <span>with {meeting.host}</span>}
                            {!enriched && <span className="mtg-chip-warn">Enriching…</span>}
                          </div>
                        </div>
                        <div className="mtg-right">
                          <span className={`mtg-status ${meeting.status}`}>{meeting.status.replace("_", " ")}</span>
                          <span className="mtg-caret">{expanded ? "▴" : "▾"}</span>
                        </div>
                      </div>
                      {expanded && <Detail meeting={meeting} history={history[meeting.id]} onDelete={() => void remove(meeting.id)} onEnrich={() => void enrichOne(meeting.id)} enriching={enriching === meeting.id} />}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </main>
      </section>
    </div>
  );
}
