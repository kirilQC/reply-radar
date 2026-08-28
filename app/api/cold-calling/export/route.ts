// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// The call list as a downloadable CSV — the readout the team exports after a call blitz.
import { NextResponse } from "next/server";
import { exportCallListCsv } from "../../../lib/cold-calling";

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug")?.trim() ?? "";
  if (!slug) return NextResponse.json({ ok: false, error: "slug is required." }, { status: 400 });
  const result = await exportCallListCsv(slug);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return new NextResponse(result.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${result.filename}"`,
    },
  });
}
