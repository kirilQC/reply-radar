// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Help center's articles. GET lists them (optionally `?q=` to search); POST carries an `action`
 * (save, delete, move) for the page's editor. The same list is read by the assistant's help_center tool.
 */

import { NextResponse } from "next/server";
import { explainConfigError } from "../../lib/app-config";
import { deleteHelpArticle, moveHelpArticle, readHelp, saveHelpArticle, searchHelp } from "../../lib/help-center";

export async function GET(request: Request) {
  try {
    const articles = await readHelp();
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json({ ok: true, articles: q.trim() ? searchHelp(articles, q, 20) : articles });
  } catch (error) {
    return NextResponse.json({ ok: false, articles: [], error: explainConfigError(error, "Help could not be loaded.") }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  try {
    if (action === "save") {
      const article = (body.article ?? {}) as Record<string, unknown>;
      return NextResponse.json({ ok: true, articles: await saveHelpArticle(article) });
    }
    if (action === "delete") {
      const id = String(body.id ?? "");
      if (!id) return NextResponse.json({ ok: false, error: "Which article?" }, { status: 400 });
      return NextResponse.json({ ok: true, articles: await deleteHelpArticle(id) });
    }
    if (action === "move") {
      const id = String(body.id ?? "");
      const direction = body.direction === "up" ? "up" : "down";
      return NextResponse.json({ ok: true, articles: await moveHelpArticle(id, direction) });
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: explainConfigError(error, "The change could not be saved.") }, { status: 502 });
  }
}
