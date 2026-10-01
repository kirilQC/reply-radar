// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Help center's storage and search.
 *
 * Articles ship with the app (help-defaults.ts) and the editor adds to or overrides them. Edits are one
 * list in rr_app_config under `help_articles`, the same small shared store the scoring
 * templates and inbox tags use: a few dozen articles does not earn a table, everyone sees the same help,
 * and the page, the Slack QC Bot and the MCP assistant all read the one copy. Search is a plain keyword
 * score rather than embeddings — the corpus is small and written by the team, so matching the words a
 * person actually typed against titles, keywords and bodies finds the right article.
 */

import { readConfig, writeConfig } from "./app-config";
import { BUILT_IN_HELP } from "./help-defaults";
import { HELP_KINDS, type HelpArticle, type HelpImage, type HelpKind, loomEmbedUrl, pageLabel } from "./help-shared";

const KEY = "help_articles";
/** Ids of built-in articles someone deleted, so they stay deleted. */
const HIDDEN_KEY = "help_articles_hidden";
const KINDS = new Set<HelpKind>(HELP_KINDS.map((kind) => kind.key));

const cleanImages = (raw: unknown): HelpImage[] =>
  (Array.isArray(raw) ? raw : [])
    .map((image) => ({ src: String((image as HelpImage)?.src ?? "").trim().slice(0, 300), caption: String((image as HelpImage)?.caption ?? "").trim().slice(0, 300) }))
    .filter((image) => image.src.startsWith("/"))
    .slice(0, 6);

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
    images: cleanImages(raw.images),
    page: String(raw.page ?? "").trim().slice(0, 100),
    keywords: (Array.isArray(raw.keywords) ? raw.keywords : String(raw.keywords ?? "").split(","))
      .map((word) => String(word).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 30),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    updatedAt: String(raw.updatedAt ?? ""),
  };
};

const parseList = (raw: unknown): unknown[] => {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw || "[]") : [];
  return Array.isArray(list) ? list : [];
};

/** Only what the editor has written. Built-ins are not copied in, so a later release can improve them. */
async function readStored(strict = false): Promise<HelpArticle[]> {
  // Writes read strictly: a failed read must not be mistaken for "no articles" and saved over the list.
  const raw = strict ? await readConfig(KEY) : await readConfig(KEY).catch(() => undefined);
  return parseList(raw)
    .map((entry, index) => clean(entry as Record<string, unknown>, index))
    .filter((entry): entry is HelpArticle => Boolean(entry));
}

async function readHidden(strict = false): Promise<string[]> {
  const raw = strict ? await readConfig(HIDDEN_KEY) : await readConfig(HIDDEN_KEY).catch(() => undefined);
  return parseList(raw).map(String);
}

const builtIns = (): HelpArticle[] =>
  BUILT_IN_HELP.map((entry, index) => clean({ ...entry, order: index, updatedAt: "" }, index))
    .filter((entry): entry is HelpArticle => Boolean(entry))
    .map((entry) => ({ ...entry, builtIn: true }));

/**
 * Every article: the built-ins that ship with the app, overlaid by anything written in the editor. An
 * edited built-in is stored under its own id and replaces the shipped copy; a deleted one is remembered
 * in HIDDEN_KEY. If the store is unreachable the built-ins still show, so Help never goes blank.
 */
export async function readHelp(): Promise<HelpArticle[]> {
  const [stored, hidden] = await Promise.all([readStored(), readHidden()]);
  const storedIds = new Set(stored.map((article) => article.id));
  const hiddenIds = new Set(hidden);
  const shipped = builtIns().filter((article) => !storedIds.has(article.id) && !hiddenIds.has(article.id));
  const builtInIds = new Set(BUILT_IN_HELP.map((entry) => entry.id));
  return [...shipped, ...stored.map((article) => (builtInIds.has(article.id) ? { ...article, builtIn: true } : article))]
    .sort((a, b) => a.order - b.order);
}

const newId = () => `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const strip = ({ builtIn: _builtIn, ...article }: HelpArticle) => article;

/** Creates (no id) or replaces (matching id) one article. Returns the whole list. */
export async function saveHelpArticle(input: Record<string, unknown>): Promise<HelpArticle[]> {
  const [all, stored] = await Promise.all([readHelp(), readStored(true)]);
  const id = String(input.id ?? "").trim() || newId();
  const existing = all.find((article) => article.id === id);
  const next = clean(
    { ...existing, ...input, id, order: existing?.order ?? (all.length ? Math.max(...all.map((a) => a.order)) + 1 : 0), updatedAt: new Date().toISOString() },
    all.length,
  );
  if (!next) throw new Error("An article needs a title.");
  const merged = stored.some((article) => article.id === id) ? stored.map((article) => (article.id === id ? next : article)) : [...stored, next];
  await writeConfig(KEY, merged.map(strip));
  return readHelp();
}

export async function deleteHelpArticle(id: string): Promise<HelpArticle[]> {
  const stored = await readStored(true);
  await writeConfig(KEY, stored.filter((article) => article.id !== id).map(strip));
  if (BUILT_IN_HELP.some((entry) => entry.id === id)) {
    const hidden = await readHidden(true);
    if (!hidden.includes(id)) await writeConfig(HIDDEN_KEY, [...hidden, id]);
  }
  return readHelp();
}

/** Moves one article up or down within its section. A built-in that moves is stored so its place sticks. */
export async function moveHelpArticle(id: string, direction: "up" | "down"): Promise<HelpArticle[]> {
  const [all, stored] = await Promise.all([readHelp(), readStored(true)]);
  const target = all.find((article) => article.id === id);
  if (!target) return all;
  const siblings = all.filter((article) => article.kind === target.kind);
  const at = siblings.findIndex((article) => article.id === id);
  const swap = siblings[direction === "up" ? at - 1 : at + 1];
  if (!swap) return all;
  const moved = [
    { ...target, order: swap.order },
    { ...swap, order: target.order === swap.order ? swap.order + (direction === "up" ? 1 : -1) : target.order },
  ];
  const movedIds = new Set(moved.map((article) => article.id));
  await writeConfig(KEY, [...stored.filter((article) => !movedIds.has(article.id)), ...moved].map(strip));
  return readHelp();
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
    screenshots: (article.images ?? []).map((image) => ({ url: `${baseUrl}${image.src}`, caption: image.caption })),
    helpUrl: `${baseUrl}/help#${article.id}`,
    body: article.body,
  };
}
