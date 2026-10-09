// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { loadDestination, presentDestination, rest, rows, saveDestination, withPushLock, type Destination } from "../../../lib/crm-push";
import { pushPass, recordKey } from "../../../lib/crm-push-run";
import { disconnectGoogle, googleAccount, googleOauthConfigured } from "../../../lib/google-user";
import { accessToken, ensureQcIdColumn, parseSheetUrl, serviceAccount, serviceAccountStatus, fieldsFor, sheetsConnect, sheetsFormat, sheetsPushMeetings, suggestMapping, type SheetConfig, type SheetContent } from "../../../lib/sheets-push";

/**
 * The onboarding cockpit's Google Sheets panel for one client (session only). GET says where it stands;
 * POST runs one step: { action: "connect", url } reads the sheet's headers and suggests a mapping,
 * "map" ({ mapping }) confirms it (adds the QC ID column, turns on automatic pushing), "reread" picks up
 * header changes, "push" ({ offset }), "auto" ({ on }), "disconnect".
 */
export const maxDuration = 300;

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function workspaceOf(c: { url: string; key: string }, slug: string) {
  const [workspace] = await rows(c, `rr_workspaces?select=id,name&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  if (!workspace) throw new Error("Unknown client.");
  return { id: text(workspace.id), name: text(workspace.name) };
}

const contentOf = (destination: { config?: unknown } | null) => (((destination?.config ?? {}) as { content?: SheetContent }).content === "meetings" ? "meetings" : "replies") as SheetContent;
const shared = async (content: SheetContent = "replies") => ({ content, google: await googleAccount().catch(() => null), googleOauth: googleOauthConfigured(), robotEmail: serviceAccount()?.client_email ?? null, googleKey: serviceAccountStatus(), fields: fieldsFor(content).map(({ key, label }) => ({ key, label })), fieldsByContent: { replies: fieldsFor("replies").map(({ key, label }) => ({ key, label })), meetings: fieldsFor("meetings").map(({ key, label }) => ({ key, label })) } });

/** Every sheet the client pushes into: the first is kind "sheets", the rest "sheets:<id>". Disconnected ones are left out. */
async function sheetsOf(c: { url: string; key: string }, workspaceId: string) {
  const all = (await rows(c, `rr_crm_push?select=*&workspace_id=eq.${encodeURIComponent(workspaceId)}&or=(kind.eq.sheets,kind.like.sheets:*)&order=created_at.asc`)) as unknown as Destination[];
  return all.filter((row) => row.api_key && row.status !== "disconnected");
}
const present = (list: Destination[]) => list.map((row) => ({ ...presentDestination(row), content: ((row.config ?? {}) as { content?: string }).content === "meetings" ? "meetings" : "replies" }));

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    // ?check=1 signs in to Google once, so setup problems surface before a sheet is connected.
    if (new URL(request.url).searchParams.get("check")) {
      const signIn = await accessToken().then(() => "ok").catch((error) => (error instanceof Error ? error.message : "failed"));
      return NextResponse.json({ ok: true, ...(await shared()), signIn });
    }
    const c = config();
    const workspace = await workspaceOf(c, (await context.params).slug);
    return NextResponse.json({ ok: true, ...(await shared()), sheets: present(await sheetsOf(c, workspace.id)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not read the sheet settings." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const body = (await request.json().catch(() => ({}))) as Row;
  const action = text(body.action);
  try {
    const c = config();
    const workspace = await workspaceOf(c, (await context.params).slug);
    if (action === "disconnect_google") {
      await disconnectGoogle();
      return NextResponse.json({ ok: true, ...(await shared()), sheets: present(await sheetsOf(c, workspace.id)) });
    }
    // Which sheet: the one named in the request, or a new one for "connect".
    const existing = await sheetsOf(c, workspace.id);
    let kind = text(body.sheet);
    if (action === "connect") {
      // The same tab twice is refused; another tab of the same spreadsheet is its own sheet.
      const target = parseSheetUrl(text(body.url));
      const clash = target && existing.find((row) => {
        const there = parseSheetUrl(text(((row.config ?? {}) as Row).url));
        return there?.spreadsheetId === target.spreadsheetId && (there.gid ?? "0") === (target.gid ?? "0");
      });
      if (clash) return NextResponse.json({ ok: false, error: "That tab is already connected for this client." }, { status: 409 });
      const first = await loadDestination(c, workspace.id, "sheets");
      kind = !first || first.status === "disconnected" || !first.api_key ? "sheets" : `sheets:${randomUUID().slice(0, 8)}`;
    }
    if (!/^sheets(:[a-z0-9-]+)?$/.test(kind)) return NextResponse.json({ ok: false, error: "Which sheet?" }, { status: 400 });
    const destination = action === "connect" ? null : await loadDestination(c, workspace.id, kind);
    const reply = async (extra: Row = {}) => NextResponse.json({ ok: true, ...extra, ...(await shared()), sheets: present(await sheetsOf(c, workspace.id)) });

    if (action === "connect" || (action === "reread" && destination)) {
      const url = action === "connect" ? text(body.url) : text(((destination?.config ?? {}) as Row).url);
      const sheet = await sheetsConnect(url);
      if (!sheet.headers.some(Boolean)) return NextResponse.json({ ok: false, error: "Add your headers in row 1 of the sheet first." }, { status: 400 });
      const previous = (destination?.config ?? {}) as Partial<SheetConfig>;
      const content: SheetContent = action === "connect" ? (body.content === "meetings" ? "meetings" : "replies") : contentOf(destination);
      // A re-read keeps the confirmed choices for headers that are still there.
      const mapping = suggestMapping(sheet.headers, content).map((suggested, index) => {
        const before = previous.headers?.indexOf(sheet.headers[index]) ?? -1;
        return before >= 0 && previous.mapping ? previous.mapping[before] ?? suggested : suggested;
      });
      await saveDestination(c, workspace.id, kind, {
        provider: "google_sheets",
        api_key: "google-service-account",
        account_id: sheet.spreadsheetId,
        account_name: sheet.title,
        status: action === "connect" ? "planned" : destination?.status ?? "planned",
        config: { ...previous, url, spreadsheetId: sheet.spreadsheetId, tab: sheet.tab, headers: sheet.headers, mapping, content } as unknown as Row,
        ...(action === "connect" ? { auto_push: false, build_log: [] } : {}),
      });
      return reply();
    }
    if (!destination) return NextResponse.json({ ok: false, error: "Connect a sheet first." }, { status: 400 });
    const sheetConfig = (destination.config ?? {}) as unknown as SheetConfig & { url: string };

    if (action === "content") {
      // What the sheet holds: replies (one row per conversation) or booked meetings (one row per person).
      const content: SheetContent = body.content === "meetings" ? "meetings" : "replies";
      if (content === contentOf(destination)) return reply();
      const mapping = suggestMapping(sheetConfig.headers, content);
      await saveDestination(c, workspace.id, kind, { config: { ...sheetConfig, content, mapping } as unknown as Row, status: "planned" });
      return reply();
    }
    if (action === "map") {
      const catalog = fieldsFor(contentOf(destination));
      const chosen = Array.isArray(body.mapping) ? (body.mapping as unknown[]).map((key) => (catalog.some((field) => field.key === key) ? String(key) : "")) : sheetConfig.mapping;
      const { headers, qcIdColumn } = await ensureQcIdColumn(sheetConfig.spreadsheetId, sheetConfig.tab, sheetConfig.headers);
      const mapping = headers.map((_, index) => (index === qcIdColumn ? "" : chosen[index] ?? ""));
      await saveDestination(c, workspace.id, kind, { config: { ...sheetConfig, headers, mapping, qcIdColumn } as unknown as Row, status: "built", ...(destination.status !== "built" ? { auto_push: true } : {}) });
      // QC's house style on every confirmed mapping; a formatting hiccup never undoes the mapping.
      const formatted = await sheetsFormat({ ...sheetConfig, headers, mapping, qcIdColumn }).then(() => "").catch((error) => (error instanceof Error ? error.message : "Formatting failed."));
      return reply(formatted ? { warning: `Mapping saved, but formatting failed: ${formatted}` } : {});
    }
    if (action === "format") {
      if (destination.status !== "built") return NextResponse.json({ ok: false, error: "Confirm the column mapping first." }, { status: 400 });
      await sheetsFormat(sheetConfig);
      return reply();
    }
    if (action === "push") {
      if (destination.status !== "built") return NextResponse.json({ ok: false, error: "Confirm the column mapping first." }, { status: 400 });
      const done = await withPushLock(c, workspace.id, kind, 300_000, async () => {
        if (contentOf(destination) === "meetings") {
          const result = await sheetsPushMeetings(c, destination as Destination);
          const summary = { pushed: result.pushed, created: result.created, updated: result.updated, unchanged: 0, failed: 0, errors: [] as string[], nextOffset: null, at: new Date().toISOString() };
          await saveDestination(c, workspace.id, kind, { last_push_at: summary.at, last_push_summary: summary as unknown as Row });
          return summary;
        }
        return pushPass(c, destination as Destination, { offset: Number(body.offset) || 0, budgetMs: 150_000 });
      });
      if (done === null) return NextResponse.json({ ok: false, error: "A push to this sheet is already running. Try again in a minute." }, { status: 409 });
      return reply({ summary: done });
    }
    if (action === "auto") {
      await saveDestination(c, workspace.id, kind, { auto_push: body.on === true });
      return reply();
    }
    if (action === "disconnect") {
      // Removes QC Command's connection to this sheet; the sheet and its rows stay as they are.
      await rest(c, `rr_crm_push?workspace_id=eq.${encodeURIComponent(workspace.id)}&kind=eq.${encodeURIComponent(kind)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      // Its push records go too, so a sheet connected later in the same slot starts fresh.
      await rest(c, `rr_crm_push_records?workspace_id=eq.${encodeURIComponent(workspace.id)}&provider=eq.${encodeURIComponent(recordKey(destination as Destination))}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return reply();
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "That step failed." }, { status: 500 });
  }
}
