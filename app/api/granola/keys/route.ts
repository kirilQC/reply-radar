// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The team's Granola keys: one per person, because a Granola key only sees its owner's meetings.
 *
 * ── A key is never returned to a browser ─────────────────────────────────────────────────────────
 * Reads mask every key to its last four characters. That is the whole of the protection this route
 * offers and it is the part that matters: the key has to be stored in full because the API needs it in
 * full, so the thing to prevent is it travelling back out to a page where a screen share or a browser
 * cache would spread it. Editing a key is therefore replacing it, not amending it.
 *
 * ── A key that does not work is worse than no key ────────────────────────────────────────────────
 * Readiness on the Slack tab counts stored keys. A revoked key that sat in the table would show as a
 * working Granola connection while contributing nothing to any brief, and the brief would go out looking
 * complete. So a key is checked against Granola before it is stored, and refused if it fails.
 */

import { NextResponse } from "next/server";
import { inspectNotes, verifyKey } from "../../../lib/granola";
// The same window a brief searches, imported rather than repeated: a Test button that listed three weeks
// of meetings would show a call the brief can no longer find, which is the exact confusion it exists to end.
import { CALL_WINDOW_DAYS } from "../../../lib/morning-brief";

type Row = Record<string, unknown>;

const TABLE = "rr_granola_keys";

function credentials() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

async function rest(url: string, key: string, path: string, init?: RequestInit) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    // The missing-table case is the one a teammate can fix themselves, and PostgREST names it exactly.
    const detail = (await response.json().catch(() => null)) as { message?: string; hint?: string } | null;
    throw new Error(detail?.message ? `Supabase refused: ${detail.message}` : `Supabase refused: HTTP ${response.status}`);
  }
  return response;
}

/** The last four characters, which is enough to tell two of your own keys apart and no use to anybody else. */
const mask = (apiKey: string) => (apiKey.length > 4 ? `••••${apiKey.slice(-4)}` : "••••");

export async function GET() {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  try {
    const response = await rest(credential.url, credential.key, `${TABLE}?select=id,label,api_key,last_checked_at,last_status,last_error&order=created_at.asc`);
    const rows = (await response.json().catch(() => [])) as Row[];
    return NextResponse.json({
      ok: true,
      keys: rows.map((row) => ({
        id: String(row.id ?? ""),
        label: String(row.label ?? ""),
        masked: mask(String(row.api_key ?? "")),
        lastCheckedAt: row.last_checked_at ?? null,
        lastStatus: String(row.last_status ?? ""),
        lastError: String(row.last_error ?? ""),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The Granola keys could not be read." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;

  const body = (await request.json().catch(() => ({}))) as Row;
  const action = String(body.action ?? "add");

  try {
    // Re-checking a stored key needs the stored key itself, which is the one read that unmasks one — and
    // it stays on the server: what comes back is the outcome, not the key.
    if (action === "check") {
      const id = String(body.id ?? "");
      if (!id) return NextResponse.json({ error: "No key was named." }, { status: 400 });
      const rows = (await (await rest(url, key, `${TABLE}?select=id,label,api_key&id=eq.${encodeURIComponent(id)}&limit=1`)).json().catch(() => [])) as Row[];
      const stored = rows[0];
      if (!stored) return NextResponse.json({ error: "That key no longer exists." }, { status: 404 });
      const apiKey = String(stored.api_key ?? "");
      const result = await verifyKey(apiKey);
      await rest(url, key, `${TABLE}?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ last_checked_at: new Date().toISOString(), last_status: result.ok ? "ok" : "error", last_error: result.error ?? null }),
      });
      /*
       * What this key can see, not merely whether it works.
       *
       * A Granola key only holds the meetings its owner recorded, so "which clients' calls are on which
       * key" is a question with no answer anywhere else — and it is the question somebody actually has
       * when a brief says no call was found. Titles and dates only: the transcript is the sensitive half
       * and no diagnostic needs it. Never fatal, because a working key that could not be listed is still
       * a working key and the check above already said so.
       */
      const meetings = result.ok
        ? await inspectNotes([{ id, label: String(stored.label ?? ""), apiKey }], [], CALL_WINDOW_DAYS)
          .then((sightings) => sightings[0]?.notes ?? [])
          .catch(() => [])
        : [];
      return NextResponse.json({
        ok: result.ok,
        error: result.error,
        windowDays: CALL_WINDOW_DAYS,
        // Newest first, which is the order somebody reads a list of meetings in.
        meetings: meetings
          .slice()
          .sort((left, right) => right.startedAt - left.startedAt)
          .map((note) => ({ title: note.title, startedAt: new Date(note.startedAt).toISOString() })),
      });
    }

    const label = String(body.label ?? "").trim();
    const apiKey = String(body.apiKey ?? "").trim();
    if (!label) return NextResponse.json({ error: "Say whose key this is, so a broken one can be handed back to the right person." }, { status: 400 });
    if (!apiKey) return NextResponse.json({ error: "No key was given." }, { status: 400 });

    // Granola's keys are prefixed. Catching this here saves a round trip and, more usefully, catches the
    // commonest paste error — the workspace id, or the whole curl line, instead of the key.
    if (!/^grn_/.test(apiKey)) {
      return NextResponse.json({ error: "A Granola API key starts with grn_. Copy it from Granola under Settings, then API." }, { status: 400 });
    }

    const checked = await verifyKey(apiKey);
    if (!checked.ok) return NextResponse.json({ error: checked.error || "Granola rejected this key." }, { status: 400 });

    await rest(url, key, TABLE, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ label, api_key: apiKey, last_checked_at: new Date().toISOString(), last_status: "ok", last_error: null }),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The key could not be saved." }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "No key was named." }, { status: 400 });
  try {
    await rest(credential.url, credential.key, `${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The key could not be removed." }, { status: 502 });
  }
}
