import { NextResponse } from "next/server";
import { listAssistants, composePersonalBrief } from "../../../lib/personal-brief";
export const maxDuration = 120;
export async function GET() {
  const people = await listAssistants();
  if (!people.length) return NextResponse.json({ error: "none" });
  const r = await composePersonalBrief(people[0]);
  return NextResponse.json({ digest: r.digest, error: r.error });
}
