// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Every Airtable base the token can see, for the picker on the client configuration tab.
 *
 * Names and ids only. The picker needs to list them and the matcher needs to compare names against a
 * workspace's own, and neither needs a schema — reading the schema of fifty bases to draw one dropdown
 * would be fifty requests against a five-per-second limit to answer a question nobody asked yet.
 * `/api/airtable/tracker` reads the one base somebody actually settled on.
 */
import { NextResponse } from "next/server";
import { isAirtableConfigured, listBases } from "../../../lib/airtable";

export async function GET() {
  if (!isAirtableConfigured()) {
    // The one setup step, said as the step. Whoever is looking at the picker is the person who can do it.
    return NextResponse.json(
      { ok: false, bases: [], error: "Airtable is not connected yet. Add AIRTABLE_API_KEY in Vercel — a personal access token with data.records:read, data.records:write and schema.bases:read — and redeploy, because Vercel only gives a new variable to a new deployment." },
      { status: 503 },
    );
  }
  const result = await listBases();
  if (!result.ok) return NextResponse.json({ ok: false, bases: [], error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, bases: result.data.map((base) => ({ id: base.id, name: base.name })) });
}
