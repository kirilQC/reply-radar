// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A client's campaign messaging, read out of a Google Doc's tabs as brain documents.
 *
 * ── Why this is pure ─────────────────────────────────────────────────────────────────────────────
 * The same split the rest of the brain filing keeps: no relative value imports and no I/O, so a test can
 * assert a tab's markdown, its path and its net-new-ness without a Google token, a clock or a network. The
 * signing, the `documents.get` fetch and the write live in `app/lib/google-docs.ts` and
 * `app/lib/messaging-sync.ts`; everything a person can reason about from the doc alone lives here.
 *
 * ── Why tabs, not the whole doc ──────────────────────────────────────────────────────────────────
 * A Google Doc's tabs are the messages: one tab is one campaign message, and the agency writes a tab once
 * and rarely touches it again. So each tab becomes its own file under `Campaign messaging/`, keyed by tab
 * id, and the daily sync files only the tabs it has not seen. Flattening `childTabs` here keeps a nested
 * tab from being silently dropped.
 */

/**
 * @typedef {Object} DocTab
 * @property {string} tabId The Google tab id, e.g. `t.6aqo2zipcjrt` — the key the sync dedupes on.
 * @property {string} title The tab's own title, used for the heading and the filename.
 * @property {string} markdown The tab body, converted to markdown.
 */

/**
 * The document id out of a Google Docs URL, or "" when the input is not one.
 *
 * Accepts a full `/document/d/<id>/edit?tab=…` URL (the common paste) and a bare id, so a person can drop
 * either. The `?tab=` fragment is deliberately ignored: the sync reads every tab, not the one that happened
 * to be open when the URL was copied.
 * @param {string} input
 * @returns {string}
 */
export function parseDocId(input) {
  const text = String(input ?? "").trim();
  if (!text) return "";
  const match = text.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  return "";
}

/**
 * The tabs tree — `tabs[]` with nested `childTabs` — flattened to an ordered list with markdown bodies.
 *
 * Depth-first so a parent precedes its children, which is the order they read in the doc. A tab with no id
 * is skipped rather than filed under a blank key, since the id is the only thing the daily dedupe has.
 * @param {unknown[]} tabs
 * @returns {DocTab[]}
 */
export function flattenDocTabs(tabs) {
  /** @type {DocTab[]} */
  const out = [];
  const walk = (list) => {
    for (const tab of Array.isArray(list) ? list : []) {
      const props = (tab && typeof tab === "object" && tab.tabProperties) || {};
      const tabId = String(props.tabId ?? "").trim();
      const title = String(props.title ?? "").trim();
      if (tabId) {
        const content = tab?.documentTab?.body?.content;
        out.push({ tabId, title: title || "Untitled tab", markdown: tabBodyToMarkdown(content) });
      }
      if (Array.isArray(tab?.childTabs) && tab.childTabs.length) walk(tab.childTabs);
    }
  };
  walk(tabs);
  return out;
}

/** One text run as markdown, carrying bold and italic without swallowing the spaces around a word. */
function runText(element) {
  const run = element?.textRun;
  if (!run || typeof run.content !== "string") return "";
  const text = run.content.replace(/\n$/, "");
  if (!text) return "";
  const style = run.textStyle && typeof run.textStyle === "object" ? run.textStyle : {};
  const lead = (text.match(/^\s*/) || [""])[0];
  const trail = (text.match(/\s*$/) || [""])[0];
  const core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text;
  let wrapped = core;
  if (style.bold) wrapped = `**${wrapped}**`;
  if (style.italic) wrapped = `_${wrapped}_`;
  return `${lead}${wrapped}${trail}`;
}

/** Heading prefix for a paragraph's named style — headings and the title become `#`s, body text stays flat. */
const HEADING_PREFIX = {
  TITLE: "# ",
  SUBTITLE: "## ",
  HEADING_1: "# ",
  HEADING_2: "## ",
  HEADING_3: "### ",
  HEADING_4: "#### ",
  HEADING_5: "##### ",
  HEADING_6: "###### ",
};

/** One paragraph as a markdown line: a bullet, a heading, or plain text. */
function paragraphMarkdown(paragraph) {
  const elements = Array.isArray(paragraph?.elements) ? paragraph.elements : [];
  const text = elements.map(runText).join("").replace(/\s+$/, "");
  if (paragraph?.bullet) {
    const level = Number(paragraph.bullet.nestingLevel ?? 0) || 0;
    return `${"  ".repeat(level)}- ${text}`.replace(/\s+$/, "");
  }
  if (!text) return "";
  const prefix = HEADING_PREFIX[String(paragraph?.paragraphStyle?.namedStyleType ?? "")] ?? "";
  return `${prefix}${text}`;
}

/**
 * A tab body — the Docs `body.content[]` — as markdown.
 *
 * Paragraphs become lines (headings, bullets or text) and tables become pipe rows built by running each
 * cell back through this same function. Anything else in the structure — section breaks, tables of
 * contents — carries no message and is left out. Three or more blank lines collapse to one, so a doc laid
 * out with spacer paragraphs does not read as a field of gaps.
 * @param {unknown[]} content
 * @returns {string}
 */
export function tabBodyToMarkdown(content) {
  const items = Array.isArray(content) ? content : [];
  const lines = [];
  for (const element of items) {
    if (element?.paragraph) {
      lines.push(paragraphMarkdown(element.paragraph));
    } else if (element?.table) {
      const rows = Array.isArray(element.table.tableRows) ? element.table.tableRows : [];
      for (const row of rows) {
        const cells = Array.isArray(row?.tableCells) ? row.tableCells : [];
        const texts = cells.map((cell) => tabBodyToMarkdown(cell?.content).replace(/\s+/g, " ").trim());
        lines.push(`| ${texts.join(" | ")} |`);
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A tab title as a filename-safe slug, matching the brain's `<slug>.md` naming elsewhere.
 *
 * Lower-cased, non-alphanumerics collapsed to single hyphens, trimmed and capped — so a tab resolves to the
 * same filename every run, which is what makes a re-sync overwrite the one file rather than file a second.
 * @param {string} title
 * @returns {string}
 */
export function messagingTabSlug(title) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "tab";
}

/** The brain path for one messaging tab: `clients/<folder>/Campaign messaging/<tab slug>.md`. */
export function messagingDocPath(folder, title) {
  return `clients/${folder}/Campaign messaging/${messagingTabSlug(title)}.md`;
}

/** A YAML scalar safe to write, double-quoted whenever plain form could be misread (titles carry colons). */
function yaml(value) {
  const text = String(value ?? "");
  if (!text) return '""';
  return /[:#"'[\]{}|>&*!?%@`]|^[\s-]|\s$/.test(text) ? JSON.stringify(text) : text;
}

/**
 * One tab as a brain document: `{ path, text }`, ready for `writeBrainFile`.
 *
 * The frontmatter names the tab, marks its source and records the day it was synced; the body is the tab's
 * heading and its markdown. An empty tab is written with a placeholder rather than as a blank file, so a
 * person opening it in the brain sees that it is empty upstream rather than broken here.
 * @param {string} folder
 * @param {DocTab} tab
 * @param {{ syncedAt?: Date }} [opts]
 * @returns {{ path: string, text: string }}
 */
export function messagingTabBrainDoc(folder, tab, opts = {}) {
  const syncedAt = (opts?.syncedAt instanceof Date ? opts.syncedAt : new Date()).toISOString().slice(0, 10);
  const path = messagingDocPath(folder, tab.title);
  const front = [
    `title: ${yaml(tab.title)}`,
    "source: Google Doc campaign messaging",
    `tab_id: ${yaml(tab.tabId)}`,
    `last_synced: ${syncedAt}`,
  ];
  const text = [
    "---",
    front.join("\n"),
    "---",
    "",
    `# ${tab.title}`,
    "",
    (tab.markdown || "").trim() || "_This tab is empty in the source document._",
    "",
  ].join("\n");
  return { path, text };
}

/**
 * The tabs not yet filed, by tab id.
 *
 * "New tabs only" is the whole daily contract: a tab written once is left alone afterwards, so an edit to a
 * tab already in the brain is not re-synced. The set membership is the mechanism.
 * @param {DocTab[]} tabs
 * @param {string[]} syncedIds
 * @returns {DocTab[]}
 */
export function unsyncedTabs(tabs, syncedIds) {
  const seen = new Set((Array.isArray(syncedIds) ? syncedIds : []).map(String));
  return (Array.isArray(tabs) ? tabs : []).filter((tab) => tab && tab.tabId && !seen.has(String(tab.tabId)));
}
