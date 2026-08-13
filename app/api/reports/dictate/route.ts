/**
 * Turns a spoken brief into the report's written sections.
 *
 * The boxes on the configurator are the half of a report the app cannot know — meetings booked, why
 * a campaign was paused, what was promised on a call. Typing five of them is the reason a Friday
 * recap slips to Monday, so this route takes a minute of dictation and files it into the right boxes
 * instead.
 *
 * It is a sorting job, not a writing job. Nothing may be invented, nothing may be inflated, and a
 * box the speaker never touched comes back empty rather than filled with something plausible — a
 * report that quietly grew a booked meeting nobody booked would be worse than a blank one.
 *
 * The transcription itself happens in the browser, so no audio ever reaches this server.
 */
import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";

type Json = Record<string, unknown>;

const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

const SYSTEM_PROMPT = `You sort a spoken brief from an account manager into the written sections of a client report.

Rules, in order of importance:
1. Use only what the speaker actually said. Never add a fact, a number, a name, a date or a commitment that is not in the transcript.
2. If the speaker said nothing relevant to a section, return an empty string for it. An empty section is dropped from the report; a guessed one is sent to a client.
3. Do not editorialise and do not add praise. If the week was bad, say what was said about it plainly.
4. Clean up speech, do not rewrite it: drop "um", false starts and repetition, fix grammar, keep the speaker's own words and their own emphasis.
5. Where a section asks for one line each, write short lines separated by newlines rather than a paragraph.
6. Write in first person plural ("we") for work we did, and name people as the speaker named them.
7. British or American spelling: match the transcript.

Reply with bare JSON and nothing else: an object whose keys are exactly the section ids you were given, each mapping to a string.`;

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY)
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not set." }, { status: 503 });

  const body = object(await request.json().catch(() => ({})));
  const transcript = text(body.transcript);
  const sections = (Array.isArray(body.sections) ? body.sections : []).map(object);
  const fields = sections
    .map((section) => ({
      id: text(section.id),
      label: text(section.label),
      placeholder: text(section.placeholder),
    }))
    .filter((field) => field.id && field.label);

  if (!transcript) return NextResponse.json({ ok: false, error: "Nothing was transcribed." }, { status: 400 });
  if (!fields.length)
    return NextResponse.json({ ok: false, error: "This report has no written sections to fill." }, { status: 400 });

  const client = text(body.client);
  const periodLabel = text(body.periodLabel);
  const userContent = `Client: ${client || "not stated"}
Period covered: ${periodLabel || "not stated"}

Sections to fill, as id — label — what the box is for:
${fields.map((field) => `${field.id} — ${field.label} — ${field.placeholder || "no guidance"}`).join("\n")}

Transcript of what the account manager said:
"""
${transcript}
"""`;

  const requestedModel = text(body.model) || process.env.ANTHROPIC_MODEL || FALLBACK_MODEL;
  let model = requestedModel;
  // A minute of speech is a few hundred words, and the reply is that text redistributed, so the
  // ceiling is there to stop a runaway rather than to shape anything.
  const requestBody = (m: string) =>
    JSON.stringify({
      model: m,
      max_tokens: 2000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });
  const headers = {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };

  try {
    const startedAt = Date.now();
    let response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(model),
    });
    if (response.status === 404 && model !== FALLBACK_MODEL) {
      model = FALLBACK_MODEL;
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: requestBody(model),
      });
    }
    const payload = (await response.json().catch(() => ({}))) as Json;
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const detail = text(object(payload.error).message) || `Anthropic returned ${response.status}`;
      return NextResponse.json({ ok: false, error: detail }, { status: 502 });
    }

    const content = Array.isArray(payload.content) ? payload.content : [];
    const raw = text(object(content.find((item) => object(item).type === "text")).text);
    // Bare JSON was asked for, but a fenced block is a common enough answer to be worth surviving.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    let parsed: Json = {};
    try {
      parsed = object(JSON.parse(fenced ? fenced[1] : raw));
    } catch {
      return NextResponse.json({ ok: false, error: "The model did not return usable JSON." }, { status: 502 });
    }

    // Only the ids we asked about come back out, so a hallucinated key cannot reach the form.
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = text(parsed[field.id]);
      if (value) values[field.id] = value;
    }

    await writeAuditEvent(
      { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY },
      {
        actor: "anthropic",
        action: "report.dictated",
        entityType: "report",
        details: {
          source: "anthropic",
          status: "success",
          model,
          durationMs,
          summary: `Filled ${Object.keys(values).length} of ${fields.length} section(s) from ${transcript.split(/\s+/).length} spoken words.`,
        },
      },
    );

    return NextResponse.json({ ok: true, values, filled: Object.keys(values) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Dictation failed" },
      { status: 502 },
    );
  }
}
