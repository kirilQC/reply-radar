// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { LEMLIST_WORKSPACE_COLUMNS, connectLemlist, disconnectLemlist, syncLemlistReplies, type LemlistWorkspace } from "../../../lib/lemlist-ingest";
import { publicBaseUrl } from "../../../lib/public-url";

/**
 * lemlist, per client, for the Configuration page. GET ?client=slug says whether the client is connected
 * (team name, masked key, webhooks, last sync). POST runs one step for one client:
 *   { action: "connect", client, apiKey }   check the key, save it, register the webhooks, pull 14 days
 *   { action: "sync", client, days? }       pull replies now (days > 0 re-reads that far back)
 *   { action: "disconnect", client }        remove QC's webhooks and forget the key
 */
export const maxDuration = 300;

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

/** The host the page is served from (www): the bare domain 308s POSTs, which webhook senders do not follow. */
const servingBase = (request: Request) => {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
  return host && !/^(localhost|127\.)/.test(host) ? `${request.headers.get("x-forwarded-proto") || "https"}://${host}` : publicBaseUrl(request);
};

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

async function client(c: { url: string; key: string }, slug: string): Promise<LemlistWorkspace | null> {
  const response = await fetch(`${c.url}/rest/v1/rr_workspaces?select=${LEMLIST_WORKSPACE_COLUMNS}&slug=eq.${encodeURIComponent(slug)}&limit=1`, { headers: { apikey: c.key, Authorization: `Bearer ${c.key}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`Run the lemlist migration first (Supabase answered ${response.status}).`);
  return ((await response.json()) as LemlistWorkspace[])[0] ?? null;
}

const present = (workspace: LemlistWorkspace) => ({
  connected: Boolean(text(workspace.lemlist_api_key)),
  teamName: workspace.lemlist_team_name ?? null,
  keyMasked: text(workspace.lemlist_api_key) ? `••••${text(workspace.lemlist_api_key).slice(-4)}` : "",
  webhooks: (workspace.lemlist_webhook_ids ?? []).length,
  syncedAt: workspace.lemlist_synced_at ?? null,
});

export async function GET(request: Request) {
  const c = config();
  if (!c) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const slug = new URL(request.url).searchParams.get("client") ?? "";
  try {
    const workspace = await client(c, slug);
    if (!workspace) return NextResponse.json({ ok: false, error: "Unknown client." }, { status: 404 });
    return NextResponse.json({ ok: true, ...present(workspace) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not read lemlist status." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const c = config();
  if (!c) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Row;
  const action = text(body.action);
  try {
    const workspace = await client(c, text(body.client));
    if (!workspace) return NextResponse.json({ ok: false, error: "Unknown client." }, { status: 404 });
    if (action === "connect") {
      const result = await connectLemlist(c, workspace, text(body.apiKey), servingBase(request));
      const fresh = await client(c, workspace.slug);
      return NextResponse.json({ ...result, ...(fresh ? present(fresh) : {}) }, { status: result.ok ? 200 : 400 });
    }
    if (action === "sync") {
      const result = await syncLemlistReplies(c, workspace, Math.min(90, Number(body.days) || 0));
      const fresh = await client(c, workspace.slug);
      return NextResponse.json({ ok: true, ...result, ingested: result.ingested.length, ...(fresh ? present(fresh) : {}) });
    }
    if (action === "disconnect") {
      await disconnectLemlist(c, workspace);
      return NextResponse.json({ ok: true, connected: false, teamName: null, keyMasked: "", webhooks: 0, syncedAt: workspace.lemlist_synced_at ?? null });
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "lemlist step failed." }, { status: 500 });
  }
}
