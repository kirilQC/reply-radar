import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../lib/audit-log";

const config = () => ({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
const headers = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" });

const statuses = ["new", "viewed", "working", "fixed"] as const;
const kinds = ["bug", "idea", "other"] as const;

type Row = {
  id: string;
  kind: string;
  message: string;
  submitted_by: string | null;
  page: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

const project = (row: Row) => ({
  id: row.id,
  kind: row.kind,
  message: row.message,
  // An empty column is the anonymous case, and the UI should say so rather than
  // render a blank byline that looks like a rendering bug.
  submittedBy: row.submitted_by || null,
  page: row.page || null,
  status: statuses.includes(row.status as (typeof statuses)[number]) ? row.status : "new",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function GET() {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const response = await fetch(`${url}/rest/v1/rr_feedback?select=*&order=created_at.desc&limit=300`, { headers: headers(key), cache: "no-store" });
  const rows = await response.json().catch(() => []);
  if (!response.ok) return NextResponse.json({ ok: false, error: JSON.stringify(rows) }, { status: response.status });
  return NextResponse.json({ ok: true, items: (Array.isArray(rows) ? rows : []).map(project) });
}

export async function POST(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json().catch(() => ({}));
  const message = String(payload.message ?? "").trim();
  if (!message) return NextResponse.json({ ok: false, error: "Tell us what happened before submitting." }, { status: 400 });
  const kind = kinds.includes(payload.kind) ? payload.kind : "other";
  // Anonymity is the default, not a checkbox we hope the client remembered to send:
  // a name is only stored when one actually arrives.
  const submittedBy = String(payload.submittedBy ?? "").trim() || null;
  const response = await fetch(`${url}/rest/v1/rr_feedback`, {
    method: "POST",
    headers: { ...headers(key), Prefer: "return=representation" },
    body: JSON.stringify({ kind, message, submitted_by: submittedBy, page: String(payload.page ?? "").trim() || null, status: "new" }),
  });
  const rows = await response.json().catch(() => []);
  if (!response.ok) return NextResponse.json({ ok: false, error: JSON.stringify(rows) }, { status: response.status });
  const saved = Array.isArray(rows) ? rows[0] : rows;
  await writeAuditEvent({ url, key }, {
    actor: "Feedback form",
    action: "feedback.submitted",
    entityType: "feedback",
    entityId: String(saved?.id ?? ""),
    // The message itself stays out of the audit feed — the point of anonymity is
    // that the report is not traceable, and the feedback table already holds it.
    details: { source: "feedback", status: "success", summary: `A ${kind} report was submitted${submittedBy ? ` by ${submittedBy}` : " anonymously"}.` },
  });
  return NextResponse.json({ ok: true, item: saved ? project(saved as Row) : null });
}

export async function PATCH(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json().catch(() => ({}));
  const id = String(payload.id ?? "");
  const status = String(payload.status ?? "");
  if (!id) return NextResponse.json({ ok: false, error: "Feedback id is required." }, { status: 400 });
  if (!statuses.includes(status as (typeof statuses)[number])) return NextResponse.json({ ok: false, error: `Status must be one of ${statuses.join(", ")}.` }, { status: 400 });
  const response = await fetch(`${url}/rest/v1/rr_feedback?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...headers(key), Prefer: "return=representation" },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
  const rows = await response.json().catch(() => []);
  if (!response.ok) return NextResponse.json({ ok: false, error: JSON.stringify(rows) }, { status: response.status });
  await writeAuditEvent({ url, key }, {
    actor: "Admin console",
    action: "feedback.status_changed",
    entityType: "feedback",
    entityId: id,
    details: { source: "admin", status: "success", summary: `A feedback item was marked ${status}.` },
  });
  const saved = Array.isArray(rows) ? rows[0] : rows;
  return NextResponse.json({ ok: true, item: saved ? project(saved as Row) : null });
}

export async function DELETE(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json().catch(() => ({}));
  const id = String(payload.id ?? "");
  if (!id) return NextResponse.json({ ok: false, error: "Feedback id is required." }, { status: 400 });
  const response = await fetch(`${url}/rest/v1/rr_feedback?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { ...headers(key), Prefer: "return=representation" } });
  const rows = await response.json().catch(() => []);
  const deleted = response.ok && Array.isArray(rows) && rows.length > 0;
  if (deleted) await writeAuditEvent({ url, key }, { actor: "Admin console", action: "feedback.deleted", entityType: "feedback", entityId: id, details: { source: "admin", status: "success", summary: "A feedback item was removed." } });
  return NextResponse.json({ ok: deleted, error: response.ok ? undefined : JSON.stringify(rows) }, { status: response.ok ? 200 : response.status });
}
