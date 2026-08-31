// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The read side of the Slack bot log.
 *
 * Every time the QC Bot answers an @-mention, a DM, or a thread reply, the Slack route writes one row
 * to `rr_audit_log` with `actor_type='slack_bot'` (see `logRun` in `app/api/slack/events/route.ts`).
 * This endpoint is the mirror image of `/api/ai/audit`: it reads that slice back for the admin AI hub.
 * There is no lead/conversation enrichment here — a Slack run is scoped to a person and a question, not
 * a lead — so the only join is the optional workspace logo, kept so a run tied to a client can show it.
 */
import { NextResponse } from "next/server";
import { resolveUserNames } from "../../../lib/slack";

type Row = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : "");
const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Number(params.get("limit") || 200), 500);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  try {
    const [response, wsResponse] = await Promise.all([
      fetch(`${url}/rest/v1/rr_audit_log?select=*&actor_type=eq.slack_bot&order=created_at.desc&limit=${limit}`, { headers, cache: "no-store" }),
      fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,logo_url`, { headers, cache: "no-store" }),
    ]);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Supabase ${response.status}: ${body.slice(0, 200)}`);
    }
    const rows = (await response.json()) as Row[];
    const workspaces = wsResponse.ok ? ((await wsResponse.json()) as Row[]) : [];
    const wsLogoById = new Map(workspaces.map((ws) => [text(ws.id), text(ws.logo_url)]));

    const events = rows.map((row) => {
      const details = object(row.details);
      const wsId = text(details.workspaceId) || text(row.workspace_id);
      return {
        id: row.id,
        timestamp: row.created_at,
        action: row.event_type,
        surface: text(details.surface) || "mention",
        channel: text(details.channel) || null,
        askedBy: text(details.askedBy) || text(row.actor_id) || null,
        askedByName: text(details.askedByName) || null,
        question: text(details.question) || null,
        outcome: text(details.outcome) || "unknown",
        durationMs: typeof details.durationMs === "number" ? details.durationMs : null,
        toolCount: typeof details.toolCount === "number" ? details.toolCount : 0,
        inputTokens: typeof details.inputTokens === "number" ? details.inputTokens : 0,
        outputTokens: typeof details.outputTokens === "number" ? details.outputTokens : 0,
        model: text(details.model) || null,
        error: text(details.error) || null,
        workspaceLogoUrl: wsLogoById.get(wsId) || null,
      };
    });

    // Fill in names for any rows that don't already carry one (older rows, before names were logged), by
    // resolving the Slack user ids in one batch.
    const needIds = Array.from(new Set(events.filter((e) => !e.askedByName && e.askedBy && /^[UW][A-Z0-9]+$/.test(e.askedBy)).map((e) => e.askedBy as string)));
    if (needIds.length) {
      const names = await resolveUserNames(needIds).catch(() => new Map<string, string>());
      for (const e of events) if (!e.askedByName && e.askedBy) e.askedByName = names.get(e.askedBy) || null;
    }

    const total = events.length;
    const succeeded = events.filter((e) => e.outcome === "success").length;
    const failed = events.filter((e) => e.outcome === "error").length;
    const totalInputTokens = events.reduce((s, e) => s + Number(e.inputTokens || 0), 0);
    const totalOutputTokens = events.reduce((s, e) => s + Number(e.outputTokens || 0), 0);

    return NextResponse.json({
      ok: true,
      events,
      summary: { total, succeeded, failed, totalInputTokens, totalOutputTokens },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load Slack bot log" }, { status: 502 });
  }
}
