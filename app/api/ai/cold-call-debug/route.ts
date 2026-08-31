import { NextResponse } from "next/server";
import { listAssistants, composePersonalBrief } from "../../../lib/personal-brief";
export const maxDuration = 120;
export async function GET() {
  const people = await listAssistants();
  if (!people.length) return NextResponse.json({ error: "no assistants configured" });
  const p = people[0];
  const r = await composePersonalBrief(p);
  return NextResponse.json({ person: p.personName, clients: r.clients, ok: r.ok, error: r.error, digest: r.digest });
}
