// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Import a CSV of contacts + phone numbers into a client's call list. The browser parses the CSV and posts
// normalized rows ({name, phone, company?, title?, linkedin?}); each becomes a callable lead with its number.
import { NextResponse } from "next/server";
import { importCsvLeads } from "../../../lib/cold-calling";

export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug ?? "");
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!slug) return NextResponse.json({ ok: false, error: "slug required" }, { status: 400 });
  if (!rows.length) return NextResponse.json({ ok: false, error: "No rows to import." }, { status: 400 });
  const result = await importCsvLeads(slug, rows);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
