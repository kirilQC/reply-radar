// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { BISON_KEY_ENV, BISON_URL_ENV, bisonConfigured, listBisonWorkspaces, matchBisonWorkspace } from "../../../lib/emailbison";
import { EMAIL_WORKSPACE_COLUMNS, diagnoseEmailLeads, ensureBisonLink, recleanEmailConversations, refreshBisonStats, registerBisonWebhook, relinkEmailLeads, syncBisonReplies, type EmailWorkspace } from "../../../lib/email-ingest";
import { publicBaseUrl } from "../../../lib/public-url";

/** The host the page is served from (www): the bare domain 308s POSTs, which webhook senders do not follow. */
const servingBase = (request: Request) => {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
  return host && !/^(localhost|127\.)/.test(host) ? `${request.headers.get("x-forwarded-proto") || "https"}://${host}` : publicBaseUrl(request);
};

/**
 * Email Bison, per client: which Bison workspace it is matched to, whether it has its own token and QC's
 * webhook, and when its replies were last synced. POST runs one step for one client (or every client):
 *   { action: "link" | "webhook" | "sync" | "stats" | "relink" | "reclean", client?: slug, workspaceId?: bison id to set by hand }
 */
export const maxDuration = 300;

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

async function clients(c: { url: string; key: string }, slug = ""): Promise<EmailWorkspace[]> {
  const filter = slug ? `slug=eq.${encodeURIComponent(slug)}` : "slug=neq.misc&offboarded_at=is.null";
  const response = await fetch(`${c.url}/rest/v1/rr_workspaces?select=${EMAIL_WORKSPACE_COLUMNS}&${filter}&order=name.asc`, { headers: { apikey: c.key, Authorization: `Bearer ${c.key}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`Run the email channel migration (20261009_email_channel.sql) first (${response.status}).`);
  return (await response.json()) as EmailWorkspace[];
}

export async function GET() {
  const c = config();
  if (!c) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  try {
    const list = await clients(c);
    const configured = bisonConfigured();
    const bisonWorkspaces = configured ? await listBisonWorkspaces().catch(() => []) : [];
    return NextResponse.json({
      ok: true,
      configured,
      env: { key: BISON_KEY_ENV, url: BISON_URL_ENV },
      bisonWorkspaces,
      clients: list.map((workspace) => {
        const row = workspace as unknown as Row;
        const linked = Number(workspace.emailbison_workspace_id) || 0;
        const guess = linked ? null : matchBisonWorkspace(workspace.name, bisonWorkspaces);
        return {
          slug: workspace.slug,
          name: workspace.name,
          bisonWorkspaceId: linked || null,
          bisonWorkspaceName: bisonWorkspaces.find((w) => w.id === linked)?.name ?? null,
          suggested: guess ? { id: guess.id, name: guess.name } : null,
          token: Boolean(text(workspace.emailbison_token)),
          webhook: Boolean(text(row.emailbison_webhook_id)),
          syncedAt: row.emailbison_synced_at ?? null,
        };
      }),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not read Email Bison status." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const c = config();
  if (!c) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  if (!bisonConfigured()) return NextResponse.json({ ok: false, error: `Set ${BISON_KEY_ENV} and ${BISON_URL_ENV} on Vercel first.` }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as Row;
  const action = text(body.action);
  try {
    const targets = await clients(c, text(body.client));
    const results: Row[] = [];
    for (const workspace of targets) {
      if (action === "link" && Number(body.workspaceId)) {
        // Set by hand: the Bison workspace this client is, with a fresh token for it.
        await fetch(`${c.url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, {
          method: "PATCH",
          headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, "content-type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ emailbison_workspace_id: Number(body.workspaceId), emailbison_token: null, emailbison_webhook_id: null, emailbison_webhook_secret: null }),
        });
        workspace.emailbison_workspace_id = Number(body.workspaceId);
        workspace.emailbison_token = null;
      }
      try {
        if (action === "link") results.push({ client: workspace.slug, linked: Boolean(await ensureBisonLink(c, workspace)) });
        else if (action === "webhook") results.push({ client: workspace.slug, ...(await registerBisonWebhook(c, workspace, servingBase(request))) });
        else if (action === "sync") results.push({ client: workspace.slug, ...(await syncBisonReplies(c, workspace, body.full === true ? 60 : 10, body.full === true)) });
        else if (action === "stats") results.push({ client: workspace.slug, ...(await refreshBisonStats(c, workspace)) });
        else if (action === "relink") results.push({ client: workspace.slug, ...(await relinkEmailLeads(c, workspace)) });
        else if (action === "diagnose") results.push({ client: workspace.slug, leads: await diagnoseEmailLeads(c, workspace) });
        else if (action === "reclean") results.push({ client: workspace.slug, ...(await recleanEmailConversations(c, workspace, Number(body.offset) || 0, Number(body.limit) || 1000)) });
        else return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
      } catch (error) {
        results.push({ client: workspace.slug, error: error instanceof Error ? error.message.slice(0, 300) : "failed" });
      }
    }
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed." }, { status: 500 });
  }
}
