/**
 * Report templates a teammate created, stored beside the built-in ones.
 *
 * Kept in a single `rr_global_config` row rather than its own table, matching what the scoring
 * templates already do. The reasoning there applies here: the production schema has drifted from
 * `supabase/schema.sql` more than once, and a list this small is not worth a migration that might be
 * written against a file which no longer describes the database. Saved reports are different — those
 * grow without bound and do get a real table.
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

type Row = Record<string, unknown>;

const CONFIG_KEY = "report_templates";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

async function db(path: string, init?: RequestInit) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase not configured");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Supabase ${path.split("?")[0]} ${response.status}`);
  return response;
}

/**
 * Reads the stored list, tolerating both a JSON string and an already-parsed array — which of those
 * comes back depends on whether `value` is a `text` or `jsonb` column, and this should not need to know.
 */
async function readSaved(): Promise<ReportTemplate[]> {
  const response = await db(`rr_global_config?select=key,value&key=eq.${CONFIG_KEY}&limit=1`);
  const rows = (await response.json().catch(() => [])) as Row[];
  const raw = rows[0]?.value;
  const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normaliseTemplate).filter((template): template is ReportTemplate => Boolean(template));
}

const writeSaved = (templates: ReportTemplate[]) =>
  db("rr_global_config", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: CONFIG_KEY, value: JSON.stringify(templates) }),
  });

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
      channel: body.channel,
      defaultPeriod: body.defaultPeriod,
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
      { ok: false, error: error instanceof Error ? error.message : "Could not save the template." },
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
      { ok: false, error: error instanceof Error ? error.message : "Could not delete the template." },
      { status: 502 },
    );
  }
}
