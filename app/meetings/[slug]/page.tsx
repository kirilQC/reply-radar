// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import "../../meetings.css";

type Meeting = {
  id: string;
  inviteeName: string | null;
  inviteeEmail: string | null;
  inviteeLinkedin: string | null;
  inviteeTitle: string | null;
  inviteeLocation: string | null;
  inviteeHeadline: string | null;
  companyName: string | null;
  companyDomain: string | null;
  companyLinkedin: string | null;
  companyLocation: string | null;
  companyIndustry: string | null;
  companySize: string | null;
  companyType: string | null;
  companyDescription: string | null;
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

function Detail({ meeting, onDelete }: { meeting: Meeting; onDelete: () => void }) {
  const rows: Array<[string, string | null, "link" | "text"]> = [
    ["Email", meeting.inviteeEmail, "text"],
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
    ["About", meeting.companyDescription, "text"],
  ];
  const cell = (value: string | null, kind: "link" | "text") => {
    if (!value) return <span style={{ color: "var(--muted-2)" }}>—</span>;
    if (kind === "link") {
      const href = value.startsWith("http") ? value : `https://${value}`;
      return <a href={href} target="_blank" rel="noreferrer">{value}</a>;
    }
    return <span>{value}</span>;
  };
  return (
    <div className="mtg-detail">
      <div className="mtg-detail-group">
        <h4>Lead</h4>
        {rows.map(([label, value, kind]) => (
          <div className="mtg-field" key={label}><b>{label}</b>{cell(value, kind)}</div>
        ))}
      </div>
      <div className="mtg-detail-group">
        <h4>Company</h4>
        {companyRows.map(([label, value, kind]) => (
          <div className="mtg-field" key={label}><b>{label}</b>{cell(value, kind)}</div>
        ))}
      </div>
      <div className="mtg-detail-actions">
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
  const [error, setError] = useState("");

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

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Link href="/meetings" className="mtg-back">← Meetings</Link>
        </header>
        <main className="mtg-shell">
          {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading meetings…</p>}
          {notFound && !loading && <div className="mtg-empty">That client was not found. <Link href="/meetings" style={{ color: "var(--accent)" }}>Back</Link>.</div>}

          {client && (
            <>
              <div className="mtg-client-head">
                <span className="mtg-logo" style={client.logoUrl ? undefined : { background: client.accentColor || "var(--accent)" }}>
                  {client.logoUrl ? <img src={client.logoUrl} alt="" /> : (client.name[0] || "?").toUpperCase()}
                </span>
                <div style={{ flex: 1 }}>
                  <h1>{client.name}</h1>
                  <Link href="/meetings" className="mtg-back">← All clients</Link>
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
                  return (
                    <div className="mtg-item" key={meeting.id}>
                      <div className="mtg-item-head" onClick={() => setOpen(expanded ? null : meeting.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpen(expanded ? null : meeting.id); }}>
                        <div className={`mtg-when ${when.tbd ? "tbd" : ""}`}>
                          <b>{when.top}</b>
                          {when.bottom && <span>{when.bottom}</span>}
                        </div>
                        <div className="mtg-who">
                          <strong>{meeting.inviteeName || meeting.inviteeEmail || "Unnamed invitee"}</strong>
                          <span className="mtg-sub">{[meeting.inviteeTitle, meeting.companyName].filter(Boolean).join(" · ") || "—"}</span>
                          <div className="mtg-meta">
                            {meeting.summary && <span>{meeting.summary}</span>}
                            {meeting.host && <span>with {meeting.host}</span>}
                            {meeting.campaign && <span>{meeting.campaign}</span>}
                          </div>
                        </div>
                        <div className="mtg-right">
                          <span className="mtg-src">{meeting.source}</span>
                          <span className={`mtg-status ${meeting.status}`}>{meeting.status.replace("_", " ")}</span>
                          <span className="mtg-caret">{expanded ? "▴" : "▾"}</span>
                        </div>
                      </div>
                      {expanded && <Detail meeting={meeting} onDelete={() => void remove(meeting.id)} />}
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
