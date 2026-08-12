/**
 * The permanent archive of generated reports.
 *
 * A saved report keeps both the artifacts (the written message, the CSV) and `data` — the exact
 * numbers it was rendered from. That redundancy is the point: months later the messages behind a
 * report may have been purged or re-scored, and a report a client has already seen must still open
 * showing what it showed on the day it was sent. Nothing here recomputes anything.
 *
 * Listing deliberately omits `data`, `csv_text` and `message_text`. Those are large, and the hub only
 * needs enough to draw a row.
 */
import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";

type Json = Record<string, unknown>;

const LIST_COLUMNS =
  "id,workspace_id,workspace_name,template_id,template_name,title,period,period_label,page_estimate,generated_by,generated_at";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

async function db(path: string, init?: RequestInit) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  return response;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = text(params.get("id"));
  const workspaceSlug = text(params.get("workspaceSlug"));

  try {
    // One report by id returns everything, because that is a request to reopen it.
    if (id) {
      const response = await db(`rr_reports?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
      if (!response.ok) throw new Error(`Supabase ${response.status}`);
      const rows = (await response.json().catch(() => [])) as Json[];
      if (!rows.length) return NextResponse.json({ ok: false, error: "That report no longer exists." }, { status: 404 });
      return NextResponse.json({ ok: true, report: rows[0] });
    }

    let filter = "";
    if (workspaceSlug && workspaceSlug !== "all") {
      const workspaces = await db(`rr_workspaces?select=id&slug=eq.${encodeURIComponent(workspaceSlug)}&limit=1`);
      const rows = (await workspaces.json().catch(() => [])) as Json[];
      const workspaceId = text(rows[0]?.id);
      // An unknown slug must not silently list every client's reports.
      if (!workspaceId) return NextResponse.json({ ok: true, reports: [] });
      filter = `&workspace_id=eq.${encodeURIComponent(workspaceId)}`;
    }

    const response = await db(`rr_reports?select=${LIST_COLUMNS}${filter}&order=generated_at.desc&limit=200`);
    if (!response.ok) throw new Error(`Supabase ${response.status}`);
    return NextResponse.json({ ok: true, reports: await response.json().catch(() => []) });
  } catch (error) {
    // A missing table is the expected state until the migration is run, and it should read as an empty
    // archive with an explanation rather than a broken page.
    return NextResponse.json({
      ok: true,
      reports: [],
      warning: error instanceof Error ? error.message : "Saved reports are unavailable.",
    });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Json;
  const title = text(body.title);
  const templateId = text(body.templateId);
  if (!title) return NextResponse.json({ ok: false, error: "The report needs a title." }, { status: 400 });
  if (!templateId) return NextResponse.json({ ok: false, error: "The report needs a template." }, { status: 400 });

  const row = {
    // null rather than "" — the column is a uuid reference, and "all clients" genuinely has no id.
    workspace_id: text(body.workspaceId) || null,
    workspace_name: text(body.workspaceName) || "All clients",
    template_id: templateId,
    template_name: text(body.templateName) || templateId,
    title,
    period: text(body.period) || "custom",
    period_label: text(body.periodLabel) || "Custom range",
    sections: Array.isArray(body.sections) ? body.sections : [],
    message_channel: text(body.messageChannel) || null,
    message_text: text(body.messageText) || null,
    csv_text: typeof body.csvText === "string" ? body.csvText : null,
    data: body.data && typeof body.data === "object" ? body.data : {},
    page_estimate: Number.isFinite(Number(body.pageEstimate)) ? Math.round(Number(body.pageEstimate)) : null,
    generated_by: text(body.generatedBy) || null,
  };

  try {
    const response = await db("rr_reports", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        payload && typeof payload === "object" ? text((payload as Json).message) : `Supabase ${response.status}`;
      throw new Error(detail || `Supabase ${response.status}`);
    }
    const saved = (Array.isArray(payload) ? payload[0] : payload) as Json | null;

    await writeAuditEvent(
      { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY },
      {
        actor: "user",
        action: "report.saved",
        entityType: "report",
        entityId: text(saved?.id) || undefined,
        details: {
          status: "success",
          templateId,
          workspaceName: row.workspace_name,
          period: row.period,
          pageEstimate: row.page_estimate,
        },
      },
    );

    return NextResponse.json({ ok: true, report: saved });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? `${error.message} — if rr_reports is missing, run supabase/migrations/20260812_rr_reports.sql.`
            : "Could not save the report.",
      },
      { status: 502 },
    );
  }
}

export async function DELETE(request: Request) {
  const id = text(new URL(request.url).searchParams.get("id"));
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  try {
    // return=representation is the only way to learn whether the delete matched anything.
    const response = await db(`rr_reports?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Prefer: "return=representation" },
    });
    if (!response.ok) throw new Error(`Supabase ${response.status}`);
    const deleted = (await response.json().catch(() => [])) as Json[];
    if (!deleted.length) return NextResponse.json({ ok: false, error: "That report no longer exists." }, { status: 404 });
    await writeAuditEvent(
      { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY },
      { actor: "user", action: "report.deleted", entityType: "report", entityId: id, details: { status: "success" } },
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Could not delete the report." },
      { status: 502 },
    );
  }
}
