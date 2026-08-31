// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Turns talk into the report's written sections.
 *
 * The boxes on the configurator are the half of a report the app cannot know — meetings booked, why
 * a campaign was paused, what was promised on a call. Typing five of them is the reason a Friday
 * recap slips to Monday, so this route takes what was said and files it into the right boxes instead.
 *
 * ── Two kinds of talk, one job ──────────────────────────────────────────────────────────────────
 * `source: "dictation"` is one person briefing the app from memory: everything in it is ours and
 * every sentence is meant for the report. `source: "call"` is a recording of the weekly sync with
 * the client — two or more speakers, an hour long, mostly not about the report at all, and half of
 * it said by the client rather than by us. Those need different instructions, because the failure
 * mode of the second is filing the client's question as our commitment, or filing an aside about
 * somebody's holiday as a priority. Same extraction, different reading of who said what.
 *
 * Either way it is a sorting job, not a writing job. Nothing may be invented, nothing may be
 * inflated, and a box nobody spoke to comes back empty rather than filled with something plausible —
 * a report that quietly grew a booked meeting nobody booked would be worse than a blank one.
 *
 * Dictation is transcribed by the browser, so no audio ever reaches this server. A call transcript is
 * pasted in as text, so none reaches it in that case either.
 */
import { NextResponse } from "next/server";
import { resolveModel, temperatureField } from "../../../../shared/anthropic-model.mjs";
import { writeAuditEvent } from "../../../lib/audit-log";

type Json = Record<string, unknown>;

const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

/**
 * An hour of two people talking is a lot of tokens.
 *
 * Sixty seconds is what this function gets, and a whole call read at once is both slow and mostly
 * irrelevant to the boxes being filled. The cap is on the input rather than the output because the
 * output is only ever a handful of short sections: it is the reading that takes the time. The *end* of
 * a call is kept when one has to be cut, since next steps and commitments are agreed on the way out.
 */
const MAX_TRANSCRIPT = 60_000;

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

/**
 * The same job, read as a conversation rather than as a briefing.
 *
 * The extra rules are all about attribution, because that is what goes wrong here. On a call the client
 * says "could you try LinkedIn ads" and the account manager says "we'll look at it" — one of those is a
 * priority and the other is a request, and a report that files the client's wish list as our plan
 * commits us to work nobody agreed to do. Everything else is the same discipline as dictation.
 */
const CALL_PROMPT = `You read the transcript of a weekly sync call between an agency account manager and their client, and sort what was said into the written sections of the client report.

Rules, in order of importance:
1. Use only what was actually said on the call. Never add a fact, a number, a name, a date or a commitment that is not in the transcript.
2. Watch who is speaking. Only record something as ours to do when our side agreed to do it — a client asking for something is not a commitment, and a possibility somebody floated is not a plan. If you cannot tell who said it, leave it out.
3. If nothing on the call was relevant to a section, return an empty string for it. An empty section is dropped from the report; a guessed one is sent to a client.
4. Most of a call is not report material: small talk, tangents, technical trouble with the call itself, things already known. Ignore all of it.
5. Numbers said out loud on a call are often approximate and are often corrected later in the same call. Prefer the later figure, and where a number was hedged ("about forty") keep the hedge rather than presenting it as exact.
6. Do not editorialise and do not add praise. If the week was bad, say what was said about it plainly.
7. Where a section asks for one line each, write short lines separated by newlines rather than a paragraph.
8. Write in first person plural ("we") for our work, and name people and companies as they were named on the call.
9. British or American spelling: match the transcript.

Reply with bare JSON and nothing else: an object whose keys are exactly the section ids you were given, each mapping to a string.`;

// Transcribing dictation then shaping it is slower than the 15s default; give it room.
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY)
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not set." }, { status: 503 });

  const body = object(await request.json().catch(() => ({})));
  const call = text(body.source) === "call";
  const spoken = text(body.transcript);
  // The tail, not the head. See MAX_TRANSCRIPT.
  const transcript = spoken.length > MAX_TRANSCRIPT ? spoken.slice(spoken.length - MAX_TRANSCRIPT) : spoken;
  const sections = (Array.isArray(body.sections) ? body.sections : []).map(object);
  const fields = sections
    .map((section) => ({
      id: text(section.id),
      label: text(section.label),
      placeholder: text(section.placeholder),
    }))
    .filter((field) => field.id && field.label);

  if (!transcript)
    return NextResponse.json(
      { ok: false, error: call ? "No transcript was pasted in." : "Nothing was transcribed." },
      { status: 400 },
    );
  if (!fields.length)
    return NextResponse.json({ ok: false, error: "This report has no written sections to fill." }, { status: 400 });

  const client = text(body.client);
  const periodLabel = text(body.periodLabel);
  const userContent = `Client: ${client || "not stated"}
Period covered: ${periodLabel || "not stated"}

Sections to fill, as id — label — what the box is for:
${fields.map((field) => `${field.id} — ${field.label} — ${field.placeholder || "no guidance"}`).join("\n")}

${call ? "Transcript of the sync call with the client:" : "Transcript of what the account manager said:"}
"""
${transcript}
"""`;

  const requestedModel = resolveModel(text(body.model) || process.env.ANTHROPIC_MODEL || FALLBACK_MODEL);
  let model = requestedModel;
  // A minute of speech is a few hundred words, and the reply is that text redistributed, so the
  // ceiling is there to stop a runaway rather than to shape anything.
  const requestBody = (m: string) =>
    JSON.stringify({
      model: m,
      // The sections are short either way — six boxes of a few lines each. A call gets a little more
      // room only because it can legitimately fill more of them at once.
      max_tokens: call ? 3000 : 2000,
      ...temperatureField(m, 0),
      system: call ? CALL_PROMPT : SYSTEM_PROMPT,
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
        action: call ? "report.transcript_filled" : "report.dictated",
        entityType: "report",
        details: {
          source: "anthropic",
          status: "success",
          model,
          durationMs,
          summary: `Filled ${Object.keys(values).length} of ${fields.length} section(s) from ${transcript.split(/\s+/).length} ${call ? "words of call transcript" : "spoken words"}.`,
        },
      },
    );

    return NextResponse.json({
      ok: true,
      values,
      filled: Object.keys(values),
      // Said rather than hidden: somebody who pasted a two-hour call needs to know the first hour of it
      // was not read, because the fix is to paste the part they cared about.
      truncated: spoken.length > transcript.length,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Dictation failed" },
      { status: 502 },
    );
  }
}
