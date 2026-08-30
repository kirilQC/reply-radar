import { NextResponse } from "next/server";
import { listColdCallClients, getCallList } from "../../../lib/cold-calling";
export const maxDuration = 30;
export async function GET() {
  const clients = await listColdCallClients();
  const misc = await getCallList("misc");
  return NextResponse.json({
    miscInDirectory: clients.some((c) => c.slug === "misc"),
    directoryCount: clients.length,
    miscCard: clients.find((c) => c.slug === "misc"),
    miscListOk: misc.ok, miscClient: misc.client, miscLeadCount: misc.leads?.length ?? 0,
  });
}
