// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { loadDestination, presentDestination, rows, saveDestination, type Destination } from "../../../lib/crm-push";
import { pushPass } from "../../../lib/crm-push-run";
import { disconnectGoogle, googleAccount, googleOauthConfigured } from "../../../lib/google-user";
import { accessToken, ensureQcIdColumn, serviceAccount, serviceAccountStatus, SHEET_FIELDS, sheetsConnect, suggestMapping, type SheetConfig } from "../../../lib/sheets-push";

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

const shared = async () => ({ google: await googleAccount().catch(() => null), googleOauth: googleOauthConfigured(), robotEmail: serviceAccount()?.client_email ?? null, googleKey: serviceAccountStatus(), fields: SHEET_FIELDS.map(({ key, label }) => ({ key, label })) });

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    // ?check=1 signs in to Google once, so setup problems surface before a sheet is connected.
    if (new URL(request.url).searchParams.get("check")) {
      const signIn = await accessToken().then(() => "ok").catch((error) => (error instanceof Error ? error.message : "failed"));
      return NextResponse.json({ ok: true, ...(await shared()), signIn });
    }
    const c = config();
    const workspace = await workspaceOf(c, (await context.params).slug);
    return NextResponse.json({ ok: true, ...(await shared()), sheet: presentDestination(await loadDestination(c, workspace.id, "sheets")) });
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
    const destination = await loadDestination(c, workspace.id, "sheets");
    const reply = async (extra: Row = {}) => NextResponse.json({ ok: true, ...extra, ...(await shared()), sheet: presentDestination(await loadDestination(c, workspace.id, "sheets")) });

    if (action === "connect" || (action === "reread" && destination)) {
      const url = action === "connect" ? text(body.url) : text(((destination?.config ?? {}) as Row).url);
      const sheet = await sheetsConnect(url);
      if (!sheet.headers.some(Boolean)) return NextResponse.json({ ok: false, error: "Add your headers in row 1 of the sheet first." }, { status: 400 });
      const previous = (destination?.config ?? {}) as Partial<SheetConfig>;
      // A re-read keeps the confirmed choices for headers that are still there.
      const mapping = suggestMapping(sheet.headers).map((suggested, index) => {
        const before = previous.headers?.indexOf(sheet.headers[index]) ?? -1;
        return before >= 0 && previous.mapping ? previous.mapping[before] ?? suggested : suggested;
      });
      await saveDestination(c, workspace.id, "sheets", {
        provider: "google_sheets",
        api_key: "google-service-account",
        account_id: sheet.spreadsheetId,
        account_name: sheet.title,
        status: action === "connect" ? "planned" : destination?.status ?? "planned",
        config: { ...previous, url, spreadsheetId: sheet.spreadsheetId, tab: sheet.tab, headers: sheet.headers, mapping } as unknown as Row,
        ...(action === "connect" ? { auto_push: false, build_log: [] } : {}),
      });
      return reply();
    }
    if (!destination) return NextResponse.json({ ok: false, error: "Connect a sheet first." }, { status: 400 });
    const sheetConfig = (destination.config ?? {}) as unknown as SheetConfig & { url: string };

    if (action === "map") {
      const chosen = Array.isArray(body.mapping) ? (body.mapping as unknown[]).map((key) => (SHEET_FIELDS.some((field) => field.key === key) ? String(key) : "")) : sheetConfig.mapping;
      const { headers, qcIdColumn } = await ensureQcIdColumn(sheetConfig.spreadsheetId, sheetConfig.tab, sheetConfig.headers);
      const mapping = headers.map((_, index) => (index === qcIdColumn ? "" : chosen[index] ?? ""));
      await saveDestination(c, workspace.id, "sheets", { config: { ...sheetConfig, headers, mapping, qcIdColumn } as unknown as Row, status: "built", ...(destination.status !== "built" ? { auto_push: true } : {}) });
      return reply();
    }
    if (action === "push") {
      if (destination.status !== "built") return NextResponse.json({ ok: false, error: "Confirm the column mapping first." }, { status: 400 });
      const summary = await pushPass(c, destination as Destination, { offset: Number(body.offset) || 0, budgetMs: 150_000 });
      return reply({ summary });
    }
    if (action === "auto") {
      await saveDestination(c, workspace.id, "sheets", { auto_push: body.on === true });
      return reply();
    }
    if (action === "disconnect_google") {
      await disconnectGoogle();
      return reply();
    }
    if (action === "disconnect") {
      await saveDestination(c, workspace.id, "sheets", { api_key: null, status: "disconnected", auto_push: false });
      return reply();
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "That step failed." }, { status: 500 });
  }
}
