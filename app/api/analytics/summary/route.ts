// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Headline counts for the home page.
 *
 * Deliberately separate from /api/analytics, which calls HeyReach, pages through every message and
 * caps conversations at 1,000 per batch — fine for the analytics screen, wrong for a number that
 * claims to be an all-time total. Everything here is a `count=exact` query, so nothing is fetched,
 * nothing is truncated, and the totals are the real ones.
 */
import { NextResponse } from "next/server";
import { countRows } from "../../../lib/rest-count";

/**
 * The wall-clock offset of a time zone at a given instant, in milliseconds.
 *
 * Formatting the instant into the zone and reading it back as if it were UTC yields the difference
 * between the two, which is the offset. This avoids hard-coding offsets that daylight saving moves.
 */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const local = Date.parse(`${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}Z`);
  return local - instant.getTime();
}

/** The local calendar date in a zone, as `YYYY-MM-DD`. */
function localDate(instant: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: Math.max(0, weekdays.indexOf(get("weekday"))),
  };
}

/**
 * The instant at which a local calendar day begins, as an ISO string.
 *
 * The offset is resolved twice because the first guess is measured at the wrong moment: on the two
 * days a year that daylight saving moves, the offset at midday differs from the offset at midnight,
 * and using the wrong one would shift the boundary by an hour.
 */
function startOfLocalDay(year: number, month: number, day: number, timeZone: string): string {
  const naive = Date.parse(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00Z`);
  let instant = new Date(naive - offsetAt(new Date(naive), timeZone));
  instant = new Date(naive - offsetAt(instant, timeZone));
  return instant.toISOString();
}

const shiftDays = (year: number, month: number, day: number, days: number) => {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });

  const requestedZone = new URL(request.url).searchParams.get("timeZone")?.trim() ?? "";
  // An unknown zone from a stale preference must not 500 the home page.
  let timeZone = "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: requestedZone || "UTC" });
    timeZone = requestedZone || "UTC";
  } catch {
    timeZone = "UTC";
  }

  const now = new Date();
  const today = localDate(now, timeZone);
  const yesterday = shiftDays(today.year, today.month, today.day, -1);
  // Weeks start on Monday: this is read by an agency reporting on a working week, and a Sunday start
  // would make Monday morning look like a fresh week had barely begun when it had not.
  const daysSinceMonday = (today.weekday + 6) % 7;
  const monday = shiftDays(today.year, today.month, today.day, -daysSinceMonday);

  const startOfToday = startOfLocalDay(today.year, today.month, today.day, timeZone);
  const startOfYesterday = startOfLocalDay(yesterday.year, yesterday.month, yesterday.day, timeZone);
  const startOfWeek = startOfLocalDay(monday.year, monday.month, monday.day, timeZone);
  const startOfMonth = startOfLocalDay(today.year, today.month, 1, timeZone);

  const replies = (since?: string, until?: string) =>
    countRows(
      url,
      key,
      `rr_messages?select=id&direction=eq.inbound${since ? `&sent_at=gte.${encodeURIComponent(since)}` : ""}${until ? `&sent_at=lt.${encodeURIComponent(until)}` : ""}`,
    );

  const [today_, yesterday_, week, month, allTime, clients, leads] = await Promise.all([
    replies(startOfToday),
    replies(startOfYesterday, startOfToday),
    replies(startOfWeek),
    replies(startOfMonth),
    replies(),
    countRows(url, key, "rr_workspaces?select=id"),
    countRows(url, key, "rr_leads?select=id"),
  ]);

  return NextResponse.json({
    ok: true,
    timeZone,
    repliesToday: today_,
    repliesYesterday: yesterday_,
    repliesThisWeek: week,
    repliesThisMonth: month,
    repliesAllTime: allTime,
    clients,
    leads,
    // Sent so the labels can name the actual period rather than guessing at the server's locale.
    monthLabel: new Intl.DateTimeFormat("en-US", { month: "long", timeZone }).format(now),
    weekStart: startOfWeek,
  });
}
