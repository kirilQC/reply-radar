/**
 * Report templates a teammate created, stored beside the built-in ones.
 *
 * Kept as one row in `rr_app_config`, a key/value table, rather than in its own table — a list this
 * small does not earn a schema of its own. Saved reports are different, and get a real table.
 *
 * This used to read and write `rr_global_config` with the same key/value query, copying what the
 * scoring templates do. That was never going to work: `rr_global_config` is a single-row settings
 * table with one column per setting and no `key` or `value` column at all, so every save failed and
 * every read was swallowed as "nothing saved yet". `rr_app_config` is the table that code was always
 * describing; see `supabase/migrations/20260812_rr_app_config.sql`.
 *
 * Built-in templates are code, not data. They are merged in on read and cannot be edited or deleted,
 * so a teammate experimenting with prompts can never leave the hub with nothing in it.
 */
import { NextResponse } from "next/server";
import {
  BUILT_IN_TEMPLATES,
  DEFAULT_TEMPLATE_PAGES,
  normaliseTemplate,
  PAGE_LIMIT,
  type ReportTemplate,
} from "../../../lib/report-templates";
import { asList, explainConfigError, readConfig, writeConfig } from "../../../lib/app-config";

type Row = Record<string, unknown>;

const CONFIG_KEY = "report_templates";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const readSaved = async (): Promise<ReportTemplate[]> =>
  asList(await readConfig(CONFIG_KEY))
    .map(normaliseTemplate)
    .filter((template): template is ReportTemplate => Boolean(template));

const writeSaved = (templates: ReportTemplate[]) => writeConfig(CONFIG_KEY, templates);

export async function GET() {
  try {
    const saved = await readSaved();
    return NextResponse.json({ ok: true, templates: [...BUILT_IN_TEMPLATES, ...saved] });
  } catch {
    // A missing row or an unreachable database must not empty the hub — the built-ins are enough to
    // work with, and reporting an error here would make the page look broken when it is not.
    return NextResponse.json({ ok: true, templates: BUILT_IN_TEMPLATES });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Row;
    const name = text(body.name).slice(0, 80);
    const prompt = text(body.prompt);
    if (!name) return NextResponse.json({ ok: false, error: "Give the template a name." }, { status: 400 });
    if (!prompt) return NextResponse.json({ ok: false, error: "A template needs a prompt." }, { status: 400 });
    if (BUILT_IN_TEMPLATES.some((template) => template.name.toLowerCase() === name.toLowerCase()))
      return NextResponse.json({ ok: false, error: "That name belongs to a built-in template. Pick another." }, { status: 409 });

    // A layout is optional on the way in — writing a template is meant to be typing a prompt — but a
    // layout that is supplied still has to respect the limit, so a caller cannot smuggle in four pages.
    const pages = Array.isArray(body.pages) && body.pages.length ? body.pages : DEFAULT_TEMPLATE_PAGES;
    if (pages.length > PAGE_LIMIT)
      return NextResponse.json(
        { ok: false, error: `A template must lay out between 1 and ${PAGE_LIMIT} pages.` },
        { status: 400 },
      );

    const existing = await readSaved();
    // Saving under a name already in use replaces it, so correcting a template a teammate is already
    // running is one action rather than a delete followed by a re-save.
    const match = existing.find((template) => template.name.toLowerCase() === name.toLowerCase());
    const template = normaliseTemplate({
      id: match?.id || `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      summary: text(body.summary),
      defaultPeriod: body.defaultPeriod,
      output: body.output,
      pages,
      prompt,
      createdAt: match?.createdAt || new Date().toISOString(),
    });
    if (!template)
      return NextResponse.json({ ok: false, error: "That template is missing a page layout." }, { status: 400 });

    await writeSaved(match ? existing.map((row) => (row.id === match.id ? template : row)) : [...existing, template]);
    return NextResponse.json({ ok: true, template, replaced: Boolean(match) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: explainConfigError(error, "Could not save the template.") },
      { status: 502 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const id = text(new URL(request.url).searchParams.get("id"));
    if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    if (BUILT_IN_TEMPLATES.some((template) => template.id === id))
      return NextResponse.json({ ok: false, error: "Built-in templates cannot be deleted." }, { status: 403 });
    const existing = await readSaved();
    await writeSaved(existing.filter((template) => template.id !== id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: explainConfigError(error, "Could not delete the template.") },
      { status: 502 },
    );
  }
}
