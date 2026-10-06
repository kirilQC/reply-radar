// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { explainConfigError, readConfig, writeConfig } from "../../../lib/app-config";

/**
 * The Sheet view's per-client settings, stored as `pm_sheet:<slug>` in rr_app_config.
 *
 * The sheet is the board laid out like the engagement trackers QC used to keep in Google Sheets: a banner
 * (title and a subtitle line for dates, north star and CRM), an "Always On" section, then a section per
 * month with a theme ("Foundation, Launches, First Signal Campaigns"). The tasks are the board's own;
 * only these words, and whether the client is an ops-only engagement that opens in the sheet, live here.
 */
type Sheet = { title: string; subtitle: string; months: Record<string, string>; opsOnly: boolean };
const KEY = (slug: string) => `pm_sheet:${slug}`;
const clean = (raw: unknown): Sheet => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const months: Record<string, string> = {};
  if (o.months && typeof o.months === "object") {
    for (const [key, value] of Object.entries(o.months as Record<string, unknown>)) {
      if ((/^\d{4}-\d{2}$/.test(key) || key === "always" || key === "undated") && typeof value === "string") months[key] = value.slice(0, 160);
    }
  }
  return {
    title: typeof o.title === "string" ? o.title.slice(0, 160) : "",
    subtitle: typeof o.subtitle === "string" ? o.subtitle.slice(0, 300) : "",
    months,
    opsOnly: o.opsOnly === true,
  };
};
const validSlug = (slug: string) => /^[a-z0-9-]{1,80}$/.test(slug);

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug") ?? "";
  if (!validSlug(slug)) return NextResponse.json({ ok: false, error: "No client given." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, sheet: clean(await readConfig(KEY(slug))) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: explainConfigError(error, "The sheet settings did not load."), sheet: clean(null) });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const slug = String(body.slug ?? "");
  if (!validSlug(slug)) return NextResponse.json({ ok: false, error: "No client given." }, { status: 400 });
  try {
    const current = clean(await readConfig(KEY(slug)).catch(() => null));
    const incoming = clean({ ...current, ...body, months: { ...current.months, ...((body.months as Record<string, unknown>) ?? {}) } });
    await writeConfig(KEY(slug), incoming);
    return NextResponse.json({ ok: true, sheet: incoming });
  } catch (error) {
    return NextResponse.json({ ok: false, error: explainConfigError(error, "The sheet settings did not save.") }, { status: 502 });
  }
}
