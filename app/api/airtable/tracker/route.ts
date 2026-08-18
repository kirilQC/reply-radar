// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Whether one mapped base's trackers are shaped the way the brief will need to write into them, and
 * the one action that builds them.
 *
 * ── The GET reports and the POST is a decision ────────────────────────────────────────────────────
 * `GET` never changes anything. The blast radius of the alternative is somebody else's workspace: a
 * client base is a thing other people work out of every day, and a column that appears in it overnight
 * without anybody asking is our bug showing up in their morning. So building the tables is `POST` —
 * behind a button somebody pressed, never a side effect of opening a settings tab.
 *
 * ── Why it reports rather than judges ─────────────────────────────────────────────────────────────
 * The `Status` and `Type` choice sets have already drifted per client — Cotool has no `Completed`,
 * Bluevia has `Completed` and `Done` and an option with an empty name — so there is no correct set to
 * check against and pretending otherwise would mark working bases as broken. What the writer will have
 * to do is pick from whatever is there, so what is there is what comes back.
 */
import { NextResponse } from "next/server";
import { auditTracker, isAirtableConfigured } from "../../../lib/airtable";
import { setUpTrackers } from "../../../lib/tracker-setup-run";

/**
 * Above the 25s the fetch itself allows, so a slow schema is reported by us rather than cut off by the
 * platform. Vercel's default would end the function first and the client would see a bare 504 with no
 * explanation of which of the two things went wrong.
 */
export const maxDuration = 60;

/**
 * Checked rather than passed straight through: `baseId` lands in a URL path, and Airtable ids are a
 * fixed shape, so anything else is a typo or a paste of something that is not a base id at all.
 */
function baseIdFrom(value: string): { baseId: string } | { error: string } {
  const baseId = value.trim();
  if (!/^app[A-Za-z0-9]{14}$/.test(baseId)) return { error: "That is not an Airtable base id. It starts with app and is 17 characters." };
  return { baseId };
}

const NOT_CONNECTED = "Airtable is not connected yet. Add AIRTABLE_API_KEY in Vercel and redeploy.";

export async function GET(request: Request) {
  if (!isAirtableConfigured()) return NextResponse.json({ ok: false, error: NOT_CONNECTED }, { status: 503 });
  const parsed = baseIdFrom(new URL(request.url).searchParams.get("baseId") ?? "");
  if ("error" in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const result = await auditTracker(parsed.baseId);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, tracker: result.data });
}

/**
 * Builds Campaign Tracker and Project Tracker in one base, and adds any column they are short of.
 *
 * Additive only, and answers `200` with the problems listed rather than a bare status, because the
 * interesting outcome here is the partial one: four columns added and the fifth refused is a base the
 * brief can half write to, and a red toast saying "failed" would hide the four that landed.
 */
export async function POST(request: Request) {
  if (!isAirtableConfigured()) return NextResponse.json({ ok: false, error: NOT_CONNECTED }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { baseId?: string };
  const parsed = baseIdFrom(String(body?.baseId ?? ""));
  if ("error" in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  return NextResponse.json({ ...(await setUpTrackers(parsed.baseId)) });
}
