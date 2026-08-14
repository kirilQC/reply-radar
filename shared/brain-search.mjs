// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Finding something in three hundred documents, when none of them are tagged.
 *
 * ── Why this is written by hand ────────────────────────────────────────────────────────────────
 * The brain has no frontmatter to filter on and no index to query, so search is the primary way in
 * for anyone who does not already know the folder layout — which is everyone this front end is being
 * built for. It has to be good, and it has to run with no dependencies, so it is a small ranked
 * matcher rather than a search engine.
 *
 * ── What ranking is actually for ───────────────────────────────────────────────────────────────
 * Not relevance in the abstract. Someone typing "willow icp" is asking for one specific document, and
 * a body-text search returns forty files that mention Willow before it. So the ordering is: a hit in
 * the path beats a hit in the title beats a hit in a heading beats a hit in the prose. That single
 * rule is what makes the difference between search being the way people navigate and search being
 * something they try once.
 *
 * Every term must appear somewhere for a file to match at all. Two words are a narrowing instruction,
 * and an OR search that returns more results the more you type is the opposite of what was asked.
 */

const lower = (value) => String(value ?? "").toLowerCase();

/** Words, lowercased, with the noise dropped. Quoted phrases are kept whole. */
export function terms(query) {
  const found = [];
  const text = String(query ?? "").trim();
  for (const match of text.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = lower(match[1] ?? match[2]).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    // One-character terms match everything and rank nothing.
    if (term.length > 1) found.push(term);
  }
  return found;
}

/** The `#` headings in a markdown file, which are the closest thing it has to a summary. */
export function headings(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => /^#{1,3}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,3}\s+/, "").trim());
}

/**
 * How well one document answers one query, and where the answer is.
 *
 * `null` rather than a zero score when a term is missing, so the caller cannot accidentally render a
 * list of non-matches sorted by how nearly they matched.
 */
export function scoreDoc({ path, text, title = "" }, wanted) {
  if (!wanted.length) return null;
  const haystackPath = lower(path);
  const haystackTitle = lower(title);
  const haystackText = lower(text);
  const heads = lower(headings(text).join(" \n "));

  let score = 0;
  for (const term of wanted) {
    const inPath = haystackPath.includes(term);
    const inTitle = haystackTitle.includes(term);
    const inHead = heads.includes(term);
    const hits = countOf(haystackText, term);
    if (!inPath && !inTitle && !inHead && !hits) return null;
    // The weights are ordered, not tuned. What matters is that a filename match always outranks any
    // number of passing mentions in someone's call notes.
    if (inPath) score += 40;
    if (inTitle) score += 24;
    if (inHead) score += 12;
    // Frequency counts, but with a hard ceiling: a document that says "Willow" ninety times is a
    // Willow document, and one that says it nine hundred times is not ten times more so.
    score += Math.min(hits, 8);
  }
  return score;
}

const countOf = (haystack, term) => {
  let count = 0;
  for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + term.length)) count += 1;
  return count;
};

/**
 * The line a term was found on, trimmed to something that fits in a result row.
 *
 * A snippet is what turns a list of filenames into an answer — often the line itself *is* what the
 * person wanted and they never open the file. Markdown syntax is stripped because `**bold**` and
 * table pipes read as noise at one line long.
 */
export function snippet(text, wanted, width = 190) {
  // Cleaned before choosing rather than after, because the choice is "does this line carry any
  // substance" and a table row is mostly pipes until it is stripped. Picking first and cleaning
  // second throws away rows that were the answer and keeps ones that were a rule of dashes.
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => ({ raw: line, clean: tidy(line) }))
    .filter((line) => line.clean.length >= 12);
  const hit =
    lines.find((line) => wanted.every((term) => lower(line.raw).includes(term))) ??
    lines.find((line) => wanted.some((term) => lower(line.raw).includes(term))) ??
    lines[0];
  const clean = hit?.clean ?? "";
  return clean.length > width ? `${clean.slice(0, width).trimEnd()}…` : clean;
}

/** A markdown line as plain prose. `**bold**` and table pipes are noise at one line long. */
const tidy = (line) =>
  String(line)
    .replace(/^[#>\-*\s]+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\||\|$/g, "")
    .replace(/\s*\|\s*/g, " · ")
    // A markdown table's separator row is punctuation pretending to be content.
    .replace(/^[-:\s·]+$/, "")
    .trim();

/**
 * The ranked answer to a query.
 *
 * Capped, because nobody reads the sixtieth result and the cap is what keeps the response small
 * enough to be worth returning over a network.
 */
export function searchBrain(docs, query, limit = 40) {
  const wanted = terms(query);
  if (!wanted.length) return [];
  const hits = [];
  for (const doc of Array.isArray(docs) ? docs : []) {
    const score = scoreDoc(doc, wanted);
    if (score === null) continue;
    hits.push({ path: doc.path, title: doc.title ?? "", score, snippet: snippet(doc.text, wanted) });
  }
  // Path as the tiebreak rather than leaving it to sort stability, so the same query gives the same
  // order twice — a list that reshuffles between identical searches reads as a broken page.
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
