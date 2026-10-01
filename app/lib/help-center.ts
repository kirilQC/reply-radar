// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Help center's storage and search.
 *
 * Articles are one list in rr_app_config under `help_articles`, the same small shared store the scoring
 * templates and inbox tags use: a few dozen articles does not earn a table, everyone sees the same help,
 * and the page, the Slack QC Bot and the MCP assistant all read the one copy. Search is a plain keyword
 * score rather than embeddings — the corpus is small and written by the team, so matching the words a
 * person actually typed against titles, keywords and bodies finds the right article.
 */

import { readConfig, writeConfig } from "./app-config";
import { HELP_KINDS, type HelpArticle, type HelpKind, loomEmbedUrl, pageLabel } from "./help-shared";

const KEY = "help_articles";
const KINDS = new Set<HelpKind>(HELP_KINDS.map((kind) => kind.key));

const clean = (raw: Record<string, unknown>, index: number): HelpArticle | null => {
  const id = String(raw.id ?? "").trim();
  const title = String(raw.title ?? "").trim();
  if (!id || !title) return null;
  const kind = KINDS.has(raw.kind as HelpKind) ? (raw.kind as HelpKind) : "faq";
  return {
    id,
    kind,
    title: title.slice(0, 200),
    body: String(raw.body ?? "").slice(0, 20_000),
    loomUrl: String(raw.loomUrl ?? "").trim().slice(0, 500),
    page: String(raw.page ?? "").trim().slice(0, 100),
    keywords: (Array.isArray(raw.keywords) ? raw.keywords : String(raw.keywords ?? "").split(","))
      .map((word) => String(word).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 30),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    updatedAt: String(raw.updatedAt ?? ""),
  };
};

export async function readHelp(): Promise<HelpArticle[]> {
  const raw = await readConfig(KEY).catch(() => undefined);
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw || "[]") : [];
  return (Array.isArray(list) ? list : [])
    .map((entry, index) => clean(entry as Record<string, unknown>, index))
    .filter((entry): entry is HelpArticle => Boolean(entry))
    .sort((a, b) => a.order - b.order);
}

const newId = () => `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Creates (no id) or replaces (matching id) one article. Returns the whole list. */
export async function saveHelpArticle(input: Record<string, unknown>): Promise<HelpArticle[]> {
  const list = await readHelp();
  const id = String(input.id ?? "").trim() || newId();
  const existing = list.find((article) => article.id === id);
  const next = clean(
    { ...existing, ...input, id, order: existing?.order ?? (list.length ? Math.max(...list.map((a) => a.order)) + 1 : 0), updatedAt: new Date().toISOString() },
    list.length,
  );
  if (!next) throw new Error("An article needs a title.");
  const merged = existing ? list.map((article) => (article.id === id ? next : article)) : [...list, next];
  await writeConfig(KEY, merged);
  return merged;
}

export async function deleteHelpArticle(id: string): Promise<HelpArticle[]> {
  const next = (await readHelp()).filter((article) => article.id !== id);
  await writeConfig(KEY, next);
  return next;
}

/** Moves one article up or down within its section. */
export async function moveHelpArticle(id: string, direction: "up" | "down"): Promise<HelpArticle[]> {
  const list = await readHelp();
  const target = list.find((article) => article.id === id);
  if (!target) return list;
  const siblings = list.filter((article) => article.kind === target.kind);
  const at = siblings.findIndex((article) => article.id === id);
  const swap = siblings[direction === "up" ? at - 1 : at + 1];
  if (!swap) return list;
  const next = list.map((article) =>
    article.id === target.id ? { ...article, order: swap.order } : article.id === swap.id ? { ...article, order: target.order } : article,
  );
  await writeConfig(KEY, next);
  return next.sort((a, b) => a.order - b.order);
}

const STOP = new Set(["a", "an", "the", "i", "to", "how", "do", "does", "can", "is", "it", "in", "on", "of", "for", "my", "me", "what", "why", "when", "where", "and", "or", "with", "this", "that", "be", "you", "we"]);
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !STOP.has(word));

/**
 * Articles ranked for a question. Title and keyword hits count most, then the page the article is about,
 * then the body. An empty query returns everything, so the assistant can also list what exists.
 */
export function searchHelp(articles: HelpArticle[], query: string, limit = 5): HelpArticle[] {
  const terms = words(query);
  if (!terms.length) return articles.slice(0, Math.max(limit, articles.length));
  const scored = articles.map((article) => {
    const title = article.title.toLowerCase();
    const body = article.body.toLowerCase();
    const page = `${article.page} ${pageLabel(article.page)}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 4;
      if (article.keywords.some((keyword) => keyword.includes(term) || term.includes(keyword))) score += 4;
      if (page.includes(term)) score += 2;
      if (body.includes(term)) score += 1;
    }
    return { article, score };
  });
  return scored.filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((row) => row.article);
}

/** What the assistant tool returns: the article in full, with the links it should hand back. */
export function helpForAssistant(article: HelpArticle, baseUrl: string) {
  return {
    title: article.title,
    section: HELP_KINDS.find((kind) => kind.key === article.kind)?.label ?? article.kind,
    page: article.page ? { name: pageLabel(article.page) || article.page, url: `${baseUrl}${article.page}` } : null,
    video: article.loomUrl && loomEmbedUrl(article.loomUrl) ? article.loomUrl : null,
    helpUrl: `${baseUrl}/help#${article.id}`,
    body: article.body,
  };
}
