// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Whether one mapped base's project tracker is shaped the way the brief will need to write into it.
 *
 * ── Read-only, deliberately ───────────────────────────────────────────────────────────────────────
 * This reports what is missing and stops there. Creating the missing fields is one more endpoint and
 * about ten lines, and it is not here because the blast radius is somebody else's workspace: a client
 * base is a thing other people work out of every day, and a column that appears in it overnight
 * without anybody asking is our bug showing up in their morning. The fix is a decision, so it gets a
 * button, not a side effect of opening a settings tab.
 *
 * ── Why it reports rather than judges ─────────────────────────────────────────────────────────────
 * The `Status` and `Type` choice sets have already drifted per client — Cotool has no `Completed`,
 * Bluevia has `Completed` and `Done` and an option with an empty name — so there is no correct set to
 * check against and pretending otherwise would mark working bases as broken. What the writer will have
 * to do is pick from whatever is there, so what is there is what comes back.
 */
import { NextResponse } from "next/server";
import { auditTracker, isAirtableConfigured } from "../../../lib/airtable";

/**
 * Above the 25s the fetch itself allows, so a slow schema is reported by us rather than cut off by the
 * platform. Vercel's default would end the function first and the client would see a bare 504 with no
 * explanation of which of the two things went wrong.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAirtableConfigured()) {
    return NextResponse.json({ ok: false, error: "Airtable is not connected yet. Add AIRTABLE_API_KEY in Vercel and redeploy." }, { status: 503 });
  }
  const baseId = new URL(request.url).searchParams.get("baseId")?.trim() ?? "";
  // Checked rather than passed straight through: `baseId` lands in a URL path, and Airtable ids are a
  // fixed shape, so anything else is a typo or a paste of something that is not a base id at all.
  if (!/^app[A-Za-z0-9]{14}$/.test(baseId)) {
    return NextResponse.json({ ok: false, error: "That is not an Airtable base id. It starts with app and is 17 characters." }, { status: 400 });
  }
  const result = await auditTracker(baseId);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, tracker: result.data });
}
