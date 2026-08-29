// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Temporary: confirm getCallList returns photo + company logo + client logo. Removed after verifying.
import { NextResponse } from "next/server";
import { getCallList } from "../../../lib/cold-calling";

export const maxDuration = 60;

export async function GET(request: Request) {
  const slug = (new URL(request.url).searchParams.get("slug") ?? "steadywell").trim();
  const list = await getCallList(slug);
  const leads = list.leads ?? [];
  return NextResponse.json({
    ok: list.ok, client: list.client,
    count: leads.length,
    withPhoto: leads.filter((l) => l.photoUrl).length,
    withCompanyLogo: leads.filter((l) => l.companyLogoUrl).length,
    sample: leads.filter((l) => l.phone).slice(0, 4).map((l) => ({ name: l.name, phone: l.phone, photoUrl: l.photoUrl, companyLogoUrl: l.companyLogoUrl, icpScore: l.icpScore })),
  });
}
