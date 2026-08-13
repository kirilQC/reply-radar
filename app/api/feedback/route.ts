import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../lib/audit-log";

const config = () => ({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
const headers = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" });

const statuses = ["new", "viewed", "working", "fixed"] as const;
const kinds = ["bug", "idea", "other"] as const;
const isStatus = (value: string) => statuses.includes(value as (typeof statuses)[number]);

/**
 * Screenshots are stored inline as data URLs rather than in object storage, which keeps the whole
 * feature inside the one table and needs no bucket to be provisioned. The browser downscales
 * before it uploads, so the cap is a guard against a pasted original, not the expected size.
 */
const MAX_SCREENSHOT_CHARS = 4_000_000;
const isImageDataUrl = (value: string) => /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);

type EventRow = {
  id: string;
  author: string | null;
  comment: string | null;
  status: string | null;
  created_at: string;
};

type Row = {
  id: string;
  kind: string;
  message: string;
  submitted_by: string | null;
  page: string | null;
  status: string;
  screenshot: string | null;
  created_at: string;
  updated_at: string;
  events?: EventRow[];
};

const projectEvent = (row: EventRow) => ({
  id: row.id,
  author: row.author || "Unsigned",
  comment: row.comment || "",
  // A null status means the update was a comment with no move — worth distinguishing, because
  // "still looking at this" and "this is fixed" are different entries in a history.
  status: row.status && isStatus(row.status) ? row.status : null,
  createdAt: row.created_at,
});

const project = (row: Row) => ({
  id: row.id,
  kind: row.kind,
  message: row.message,
  // An empty column is the anonymous case, and the UI should say so rather than
  // render a blank byline that looks like a rendering bug.
  submittedBy: row.submitted_by || null,
  page: row.page || null,
  status: isStatus(row.status) ? row.status : "new",
  screenshot: row.screenshot || null,
  // Oldest first: a history is read forwards, from the report to wherever it got to.
  history: (Array.isArray(row.events) ? row.events : [])
    .map(projectEvent)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** One row plus its history, for the responses that hand a single updated item back. */
const fetchOne = async (url: string, key: string, id: string) => {
  const response = await fetch(
    `${url}/rest/v1/rr_feedback?id=eq.${encodeURIComponent(id)}&select=*,events:rr_feedback_events(*)`,
    { headers: headers(key), cache: "no-store" },
  );
  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? project(row as Row) : null;
};

export async function GET() {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const response = await fetch(`${url}/rest/v1/rr_feedback?select=*,events:rr_feedback_events(*)&order=created_at.desc&limit=300`, { headers: headers(key), cache: "no-store" });
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
  const screenshot = String(payload.screenshot ?? "").trim();
  if (screenshot && !isImageDataUrl(screenshot)) return NextResponse.json({ ok: false, error: "The screenshot must be a PNG, JPEG, WebP or GIF image." }, { status: 400 });
  if (screenshot.length > MAX_SCREENSHOT_CHARS) return NextResponse.json({ ok: false, error: "That screenshot is too large. Crop it and try again." }, { status: 413 });
  const response = await fetch(`${url}/rest/v1/rr_feedback`, {
    method: "POST",
    headers: { ...headers(key), Prefer: "return=representation" },
    body: JSON.stringify({ kind, message, submitted_by: submittedBy, page: String(payload.page ?? "").trim() || null, status: "new", screenshot: screenshot || null }),
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
    details: { source: "feedback", status: "success", summary: `A ${kind} report was submitted${submittedBy ? ` by ${submittedBy}` : " anonymously"}${screenshot ? " with a screenshot" : ""}.` },
  });
  return NextResponse.json({ ok: true, item: saved ? project(saved as Row) : null });
}

/**
 * Posts an update against a report: a signed comment, a status move, or both.
 *
 * A name is required even when nothing but the status changes. The whole point of the log is that
 * every step has someone's name on it, so an unattributed move would be a hole in the record —
 * and moving the status is exactly the step people would otherwise do without signing.
 */
export async function PATCH(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json().catch(() => ({}));
  const id = String(payload.id ?? "");
  const status = String(payload.status ?? "");
  const comment = String(payload.comment ?? "").trim();
  const author = String(payload.author ?? "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "Feedback id is required." }, { status: 400 });
  if (!author) return NextResponse.json({ ok: false, error: "Sign the update with your name." }, { status: 400 });
  if (status && !isStatus(status)) return NextResponse.json({ ok: false, error: `Status must be one of ${statuses.join(", ")}.` }, { status: 400 });
  if (!status && !comment) return NextResponse.json({ ok: false, error: "Add a comment or change the status." }, { status: 400 });

  if (status) {
    const patched = await fetch(`${url}/rest/v1/rr_feedback?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...headers(key), Prefer: "return=representation" },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    });
    if (!patched.ok) {
      const error = await patched.json().catch(() => ({}));
      return NextResponse.json({ ok: false, error: JSON.stringify(error) }, { status: patched.status });
    }
  }

  const logged = await fetch(`${url}/rest/v1/rr_feedback_events`, {
    method: "POST",
    headers: { ...headers(key), Prefer: "return=representation" },
    // The status is recorded on the event as well as the parent row. The parent says where the
    // report stands now; the event says who moved it there and when.
    body: JSON.stringify({ feedback_id: id, author, comment: comment || null, status: status || null }),
  });
  if (!logged.ok) {
    const error = await logged.json().catch(() => ({}));
    return NextResponse.json({ ok: false, error: JSON.stringify(error) }, { status: logged.status });
  }

  await writeAuditEvent({ url, key }, {
    actor: author,
    action: status ? "feedback.status_changed" : "feedback.commented",
    entityType: "feedback",
    entityId: id,
    details: { source: "admin", status: "success", summary: status ? `${author} marked a feedback item ${status}.` : `${author} commented on a feedback item.` },
  });
  return NextResponse.json({ ok: true, item: await fetchOne(url, key, id) });
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
