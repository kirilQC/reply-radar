// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { jevClient, jevConfig, loadQuestionSet, loadTagSet, saveQuestionSet, saveTagSet } from "../../../lib/jev";

const slugOf = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

// One client's saved question set, plus whether Jev itself is reachable (a key is set).
export async function GET(request: Request) {
  const slug = slugOf(new URL(request.url).searchParams.get("client"));
  if (!slug) return NextResponse.json({ ok: false, error: "Pass ?client=<slug>." }, { status: 400 });
  try {
    const client = await jevClient(slug);
    if (!client) return NextResponse.json({ ok: false, error: "Unknown client." }, { status: 404 });
    const { apiKey, model } = jevConfig();
    const [set, tags] = await Promise.all([loadQuestionSet(slug), loadTagSet(slug)]);
    return NextResponse.json({ ok: true, client, set, tags, jev: { configured: Boolean(apiKey), model } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not read the question set." }, { status: 502 });
  }
}

// Replace a client's question set with an edited one. Unusable questions are dropped and reported, not saved.
export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = slugOf(body?.client);
  if (!slug) return NextResponse.json({ ok: false, error: "client is required." }, { status: 400 });
  try {
    if (!(await jevClient(slug))) return NextResponse.json({ ok: false, error: "Unknown client." }, { status: 404 });
    // `kind: "tags"` saves the client's company tag set; anything else is the contact screening questions.
    if (body?.kind === "tags") {
      const { set, problems } = await saveTagSet(slug, body?.set, "manual");
      if (!set.tags.length) return NextResponse.json({ ok: false, error: "A tag set needs at least two tags.", problems }, { status: 422 });
      return NextResponse.json({ ok: true, set, problems });
    }
    const { set, problems } = await saveQuestionSet(slug, body?.set, "manual");
    if (!set.questions.length) return NextResponse.json({ ok: false, error: "No usable question to save.", problems }, { status: 422 });
    return NextResponse.json({ ok: true, set, problems });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not save the question set." }, { status: 502 });
  }
}
