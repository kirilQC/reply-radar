import { NextResponse } from "next/server";
import { getCallList } from "../../../lib/cold-calling";
export const maxDuration = 60;
export async function GET() {
  const list = await getCallList("steadywell");
  const leads = list.leads ?? [];
  return NextResponse.json({
    ok: list.ok, count: leads.length,
    withReply: leads.filter((l) => l.replied).length,
    withLastReplyAt: leads.filter((l) => l.lastReplyAt).length,
    campaignsSeen: Array.from(new Set(leads.flatMap((l) => l.campaigns))).slice(0, 8),
    sendersSeen: Array.from(new Set(leads.flatMap((l) => l.senders))).slice(0, 8),
    sampleReplied: leads.filter((l) => l.replied).slice(0, 2).map((l) => ({ name: l.name, status: l.status, lastReplyAt: l.lastReplyAt, senders: l.senders, campaigns: l.campaigns })),
  });
}
