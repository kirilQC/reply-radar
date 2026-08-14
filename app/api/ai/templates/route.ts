// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { asList, explainConfigError, readConfig, writeConfig } from "../../../lib/app-config";

/**
 * Scoring prompts a teammate wrote and chose to keep, shared across every client.
 *
 * Stored as one row in `rr_app_config` rather than a table of its own — a named list this small does
 * not earn a schema. This used to address `rr_global_config` with the same key/value query, on the
 * belief that it was "a path that is known to work" because the sentiment prompt saved through it. It
 * was not: that table has no `key` or `value` column, so every save 400d and every read was caught and
 * reported as "no saved templates". Nothing written here was ever stored.
 *
 * Saving here is deliberately separate from saving a client's own prompt. Most custom prompts are for
 * one client and belong nowhere else; only the ones worth reusing get a name.
 */
type Row = Record<string, unknown>;
export type SavedTemplate = { id: string; kind: "icp" | "follow_up"; name: string; summary: string; prompt: string; createdAt: string };

const CONFIG_KEY = "scoring_templates";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

async function readTemplates(): Promise<SavedTemplate[]> {
  return asList(await readConfig(CONFIG_KEY))
    .map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as Row;
      return {
        id: text(row.id),
        kind: row.kind === "icp" ? "icp" as const : "follow_up" as const,
        name: text(row.name),
        summary: text(row.summary),
        prompt: typeof row.prompt === "string" ? row.prompt : "",
        createdAt: text(row.createdAt),
      };
    })
    .filter((template) => template.id && template.name && template.prompt);
}

const writeTemplates = (templates: SavedTemplate[]) => writeConfig(CONFIG_KEY, templates);

export async function GET() {
  try {
    return NextResponse.json({ ok: true, templates: await readTemplates() });
  } catch {
    // A missing row, a drifted column, or an unreachable database must not take the AI config page
    // down — it just means there are no saved templates to offer alongside the vetted ones.
    return NextResponse.json({ ok: true, templates: [] });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const kind = body.kind === "icp" ? "icp" as const : "follow_up" as const;
    const name = text(body.name).slice(0, 80);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!name) return NextResponse.json({ ok: false, error: "Give the template a name." }, { status: 400 });
    if (!prompt) return NextResponse.json({ ok: false, error: "There is no prompt to save." }, { status: 400 });

    const existing = await readTemplates();
    // Saving under a name already in use replaces it, so fixing a template a teammate is already
    // using is one action rather than a delete followed by a re-save under the same name.
    const match = existing.find((template) => template.kind === kind && template.name.toLowerCase() === name.toLowerCase());
    const template: SavedTemplate = {
      id: match?.id || `saved-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      name,
      summary: text(body.summary).slice(0, 200),
      prompt,
      createdAt: match?.createdAt || new Date().toISOString(),
    };
    await writeTemplates(match ? existing.map((row) => (row.id === match.id ? template : row)) : [...existing, template]);
    return NextResponse.json({ ok: true, template, replaced: Boolean(match) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: explainConfigError(error, "Could not save the template.") }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  try {
    const id = text(new URL(request.url).searchParams.get("id"));
    if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    const existing = await readTemplates();
    await writeTemplates(existing.filter((template) => template.id !== id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: explainConfigError(error, "Could not delete the template.") }, { status: 502 });
  }
}
