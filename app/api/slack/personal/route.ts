// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The personal-assistant automation: per-person morning briefs DM'd to each team member.
 *
 * GET  — the roster (people + their config), the client directory for the multi-select, and which people are
 *        due to be DM'd right now (the worker consumes `due`).
 * PATCH — create/update one person (`assistant`) or delete one (`delete: {id}`).
 * POST  — compose and DM one person's focus note now (`id`), used by the worker and the "Send now" button.
 *
 * It leans entirely on the morning-brief engine (see app/lib/personal-brief.ts) and the same schedule maths as
 * the brief, so a person's schedule behaves exactly like a client's.
 */
import { NextResponse } from "next/server";
import { isDueNow, alreadySentToday } from "../../../lib/morning-brief-schedule";
import { slackConfigured } from "../../../lib/slack";
import {
  listAssistants,
  upsertAssistant,
  deleteAssistant,
  personalClientDirectory,
  sendPersonalBrief,
  assistantSchedule,
} from "../../../lib/personal-brief";

export const maxDuration = 300;

export async function GET() {
  const [people, clients] = await Promise.all([listAssistants(), personalClientDirectory()]);
  const now = new Date();
  const due = people
    .filter((p) => p.enabled && p.slackUserId && p.clientSlugs.length && isDueNow(assistantSchedule(p), now) && !alreadySentToday(p.lastSentAt, assistantSchedule(p), now))
    .map((p) => p.id);
  return NextResponse.json({ ok: true, slackConfigured: slackConfigured(), people, clients, due });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.delete && typeof body.delete === "object") {
    const id = String((body.delete as { id?: unknown }).id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "Missing id." }, { status: 400 });
    const result = await deleteAssistant(id);
    return result.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: "Could not delete." }, { status: 400 });
  }
  const a = (body.assistant ?? body) as Record<string, unknown>;
  const result = await upsertAssistant({
    id: typeof a.id === "string" ? a.id : undefined,
    personName: String(a.personName ?? ""),
    slackUserId: String(a.slackUserId ?? ""),
    clientSlugs: Array.isArray(a.clientSlugs) ? a.clientSlugs.map((s) => String(s)) : [],
    enabled: Boolean(a.enabled),
    sendDays: Array.isArray(a.sendDays) ? a.sendDays.map(Number) : [],
    sendHour: Number(a.sendHour ?? 8),
    sendMinute: Number(a.sendMinute ?? 0),
    timezone: String(a.timezone ?? "America/New_York"),
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, assistant: result.assistant });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: unknown };
  const id = String(body?.id ?? "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "Missing id." }, { status: 400 });
  const person = (await listAssistants()).find((p) => p.id === id);
  if (!person) return NextResponse.json({ ok: false, error: "No such assistant." }, { status: 404 });
  const result = await sendPersonalBrief(person);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, clients: result.clients });
}
