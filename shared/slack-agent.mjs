// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The pure half of the Slack agent: everything the events route needs that has no I/O in it.
 *
 * The route itself has to talk to Slack, Anthropic and Supabase and cannot be tested without them. The
 * three things that are actually easy to get wrong — verifying Slack's request signature, pulling the
 * real question out of an @-mention, and turning the assistant's rich markdown into Slack's flavour —
 * are all pure string work, so they live here and `tests/slack-agent.test.mjs` drives them directly.
 *
 * Plain ESM, no imports but `node:crypto` (a builtin), on purpose: a test can import this file and
 * exercise the signature check without standing anything up.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack signs every request `v0=<hex>`; the version is part of the signed string, not decoration. */
const SIGNATURE_VERSION = "v0";
/**
 * How old a request may be and still be honoured. Slack's own guidance is five minutes: it is the
 * window that stops a captured request being replayed later, and it is long enough that ordinary clock
 * skew between Slack and the server never trips it.
 */
const MAX_SKEW_SECONDS = 300;

/**
 * Whether a request genuinely came from Slack.
 *
 * The signature is an HMAC-SHA256 over `v0:{timestamp}:{raw body}` keyed with the app's signing secret,
 * so the raw body has to be hashed exactly as it arrived — parse it into JSON first and re-serialise and
 * the bytes differ and every request looks forged. The timestamp is checked before the hash to refuse a
 * replay of an old but validly signed request, and the comparison is constant-time so a caller cannot
 * learn the secret one byte at a time by timing the failures.
 *
 * @param {{ signingSecret: string; timestamp: string; body: string; signature: string; now?: number }} opts
 * @returns {boolean}
 */
export function verifySlackSignature(opts) {
  const { signingSecret, timestamp, body, signature } = opts;
  if (!signingSecret || !timestamp || !signature) return false;

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - sent) > MAX_SKEW_SECONDS) return false;

  const expected = `${SIGNATURE_VERSION}=${createHmac("sha256", signingSecret).update(`${SIGNATURE_VERSION}:${timestamp}:${body}`).digest("hex")}`;
  // `timingSafeEqual` throws on a length mismatch, which a forged signature of the wrong length would
  // cause; that is still a "no", so the throw is caught rather than surfaced.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * The question, with the bot mention and Slack's link syntax taken out.
 *
 * An `app_mention` arrives as "<@U123BOT> how did Cotool do this week", and the leading mention is
 * noise the model should never see. Every `<@U…>` token goes, and Slack's `<url|label>` and `<url>`
 * link forms are reduced to their human text so the model reads "the dashboard" rather than the angle
 * brackets. What is left is trimmed; an empty result means the mention had no question in it.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanMention(text) {
  return String(text ?? "")
    // User and bot mentions: <@U123> and <@U123|name>.
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/gi, " ")
    // Channel mentions: <#C123|name>.
    .replace(/<#[A-Z0-9]+(\|[^>]*)?>/gi, " ")
    // Links: <https://x|label> keeps the label, <https://x> keeps the url.
    .replace(/<(https?:[^>|]+)\|([^>]+)>/gi, "$2")
    .replace(/<(https?:[^>]+)>/gi, "$1")
    // Slack's special mentions: <!here>, <!channel>.
    .replace(/<![^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The fenced blocks the web app renders as visuals and Slack cannot. Their JSON body is noise in chat. */
const VISUAL_LANGS = new Set(["stats", "chart", "map", "cards", "timeline", "export"]);

/**
 * Drops the visual and export fenced blocks, leaving the prose and tables that carry the same numbers.
 *
 * The assistant is told these blocks only ever restate figures already in the answer's words or its
 * table, so removing them loses no information — where in Slack their raw JSON would be a wall of braces
 * nobody can read. A generic code block (no language, or a real one) is left untouched.
 *
 * @param {string} markdown
 * @returns {string}
 */
function stripVisualBlocks(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const out = [];
  let dropping = false;
  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const lang = (fence[1] ?? "").toLowerCase();
      if (!dropping && VISUAL_LANGS.has(lang)) {
        dropping = true;
        continue;
      }
      if (dropping) {
        // The closing fence of a block we are dropping.
        dropping = false;
        continue;
      }
    }
    if (!dropping) out.push(line);
  }
  return out.join("\n");
}

/** A cell's markdown reduced to plain text, so a fixed-width table does not carry stray `**` or links. */
const plainCell = (cell) => inlineToMrkdwn(cell).replace(/\*/g, "").trim();

/**
 * Rewrites GitHub-flavoured tables as a monospace block, because Slack has no table.
 *
 * A markdown table is a header row, a `---` separator, then body rows. Slack renders none of that, so
 * the columns are measured and padded into a code block, which Slack shows in a fixed-width font — the
 * only way rows and columns stay lined up in a message. A run of non-table lines passes through
 * untouched.
 *
 * @param {string} markdown
 * @returns {string}
 */
function tablesToText(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const out = [];
  let index = 0;
  const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isSeparator = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
  const cells = (line) =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

  while (index < lines.length) {
    const line = lines[index];
    if (isRow(line) && index + 1 < lines.length && isSeparator(lines[index + 1])) {
      const header = cells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && isRow(lines[index]) && !isSeparator(lines[index])) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      const columns = Math.max(header.length, ...rows.map((row) => row.length));
      const grid = [header, ...rows].map((row) =>
        Array.from({ length: columns }, (_, column) => plainCell(row[column] ?? "")),
      );
      const widths = Array.from({ length: columns }, (_, column) =>
        Math.max(...grid.map((row) => row[column].length)),
      );
      const pad = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
      const rendered = ["```", pad(grid[0]), ...grid.slice(1).map(pad), "```"];
      out.push(...rendered);
      continue;
    }
    out.push(line);
    index += 1;
  }
  return out.join("\n");
}

/**
 * Inline markdown to Slack's mrkdwn, on one line's worth of text.
 *
 * Slack's syntax overlaps markdown but is not it: bold is one asterisk not two, links are `<url|label>`,
 * and there are no headings or images. This does the substitutions that would otherwise show up as raw
 * markup — a `**figure**` printed with its asterisks reads as an error even though the number is right.
 *
 * @param {string} text
 * @returns {string}
 */
export function inlineToMrkdwn(text) {
  return String(text ?? "")
    // Images first, before links, since `![alt](url)` also matches the link pattern.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // Links: [label](url) -> <url|label>.
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>")
    // Bold: **x** or __x__ -> *x*. Done before italics so the inner markers are gone first.
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/__([^_]+)__/g, "*$1*");
}

/**
 * The assistant's answer, rewritten so it reads correctly in a Slack message.
 *
 * The order is deliberate: the visual blocks are dropped first so their JSON never reaches the table or
 * inline passes, then tables become monospace blocks, then the remaining lines get inline conversion —
 * skipping anything inside a code fence, because a table we just rendered or a block of code the model
 * wrote must not have its contents rewritten. Headings, which Slack has no equivalent for, become bold.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function toSlackText(markdown) {
  const withoutVisuals = stripVisualBlocks(markdown);
  const withTables = tablesToText(withoutVisuals);
  const lines = withTables.split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // A heading has no Slack form; the text of it, bolded, is the closest honest rendering.
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`*${plainCell(heading[1])}*`);
      continue;
    }
    out.push(inlineToMrkdwn(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A tool call, said the way a person would say it — so the progress message reads as "checking campaign
 * analytics" rather than "heyreach_campaign_metrics".
 *
 * The tool names are an implementation detail; what the reader wants is the *source* being consulted.
 * Where a call is scoped to one client the name is folded in, because "Reading Cotool's context" is more
 * reassuring than a bare verb — it shows the bot understood which client was asked about. An unknown tool
 * degrades to its name with the underscores softened rather than being dropped, so a tool added later
 * still shows something rather than a blank line.
 */
const PROGRESS_LABELS = {
  list_clients: "Listing clients",
  client_summary: "Reading the client summary",
  database_totals: "Counting the lead database",
  recent_replies: "Pulling recent replies",
  awaiting_reply: "Finding leads awaiting a reply",
  find_person: "Looking up a person",
  search_leads: "Searching leads",
  read_conversation: "Reading a conversation",
  heyreach_campaigns: "Listing campaigns",
  heyreach_campaign_metrics: "Checking campaign analytics",
  heyreach_senders: "Checking sender accounts",
  heyreach_person_campaigns: "Checking a person's campaigns",
  heyreach_campaign_sequence: "Reading a campaign sequence",
  heyreach_lists: "Listing HeyReach lists",
  heyreach_export_list: "Exporting a list",
  heyreach_workspace_totals: "Totalling the HeyReach workspace",
  heyreach_inbox_search: "Searching the HeyReach inbox",
  heyreach_person_profile: "Reading a LinkedIn profile",
  brain_search: "Searching the QC Brain",
  brain_read: "Reading from the QC Brain",
  brain_client: "Reading the client's QC Brain",
  brain_write: "Drafting a QC Brain edit",
  brain_skills: "Checking QC playbooks",
  airtable_tables: "Reading the Airtable schema",
  airtable_records: "Reading Airtable records",
  airtable_create_records: "Adding rows to Airtable",
  airtable_update_records: "Updating rows in Airtable",
};

/**
 * The human phrase for one tool call.
 *
 * @param {string} tool
 * @param {unknown} [input]
 * @returns {string}
 */
export function progressLabel(tool, input) {
  const base = PROGRESS_LABELS[tool] ?? (String(tool ?? "").replace(/_/g, " ").trim() || "Working");
  const client = input && typeof input === "object" ? String(input.client ?? "").trim() : "";
  if (client && (tool === "client_summary" || tool === "brain_client")) return `Reading ${client}'s context`;
  if (client) return `${base} · ${client}`;
  return base;
}

/** How many step lines the progress message shows; older steps roll off the top so it never grows unbounded. */
const MAX_PROGRESS_STEPS = 8;

/**
 * The live "thinking" message, rebuilt from the steps so far.
 *
 * Finished steps carry a check (or a warning if the lookup failed), the ones still running carry an
 * hourglass — so the reader sees the bot working through sources rather than a frozen spinner. Only the
 * most recent handful are shown; a thirty-round research loop would otherwise post a wall of ticks.
 *
 * `elapsedMs`, when given, drives the heartbeat: the running time is shown in the header, and when every
 * visible step is finished — the gap where the model has stopped calling tools and is composing the
 * answer — a trailing "still working" line is added. Without it the message would sit on a wall of ticks
 * with nothing moving, which reads as a crash even though the bot is mid-sentence. The elapsed figure is
 * what makes two heartbeat edits differ, so Slack does not reject the second as a no-op.
 *
 * @param {Array<{ label: string; status: "doing" | "ok" | "fail" }>} steps
 * @param {{ elapsedMs?: number }} [opts]
 * @returns {string}
 */
export function progressText(steps, opts = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const shown = list.slice(-MAX_PROGRESS_STEPS);
  const hidden = list.length - shown.length;
  const icon = (status) => (status === "ok" ? "✓" : status === "fail" ? "⚠️" : "⏳");
  const lines = shown.map((step) => `${icon(step.status)}  ${step.label}`);
  const elapsedMs = typeof opts?.elapsedMs === "number" && opts.elapsedMs >= 0 ? opts.elapsedMs : null;
  const clock = elapsedMs === null ? "" : ` _(${Math.round(elapsedMs / 1000)}s)_`;
  const base = hidden > 0 ? `:mag: *Looking into it…* _(+${hidden} earlier)_` : ":mag: *Looking into it…*";
  const head = `${base}${clock}`;
  // Between tool calls — or once the last one is done and the answer is being written — nothing on the
  // list is moving. The heartbeat line is the only proof the bot is still alive, so add it whenever a
  // clock is being shown and no step is currently running.
  const stillWorking = elapsedMs !== null && list.length > 0 && !list.some((step) => step.status === "doing");
  const tail = stillWorking ? ["⏳  Still working on it…"] : [];
  return [head, "", ...lines, ...tail].join("\n").trimEnd();
}

/** How many turns back the assistant reads a thread. A long back-and-forth is trimmed to the recent ones. */
const MAX_THREAD_TURNS = 20;

/** Whether a post was written by QC Bot itself, by either of the two ids Slack might stamp it with. */
const isOurBot = (post, identity) => {
  const userId = identity?.userId ?? "";
  const botId = identity?.botId ?? "";
  return Boolean((userId && post?.author === userId) || (botId && post?.botId === botId));
};

/**
 * Whether QC Bot has already spoken in this thread.
 *
 * This is the gate on answering a reply that did not mention the bot: an ongoing conversation is one the
 * bot is already part of, so a reply in a thread it has never posted in is somebody else's discussion and
 * is left alone. Without this the bot would jump into every threaded reply in every channel it can see.
 *
 * @param {Array<{ author: string; botId: string }>} posts
 * @param {{ userId?: string; botId?: string }} identity
 * @returns {boolean}
 */
export function botParticipated(posts, identity) {
  return (Array.isArray(posts) ? posts : []).some((post) => isOurBot(post, identity));
}

/**
 * A thread of Slack posts turned into the alternating turns the model expects.
 *
 * QC Bot's own posts become `assistant` turns — its memory of what it already said — and everyone else's
 * become `user` turns, with the bot mention stripped the same way a fresh question is. Two turns from the
 * same side in a row are merged, because Anthropic rejects consecutive same-role messages and two people
 * (or a person across two messages) reading as one voice is closer to the truth than an error. Any
 * assistant turns at the very front are dropped so the conversation opens on a person, and only the most
 * recent turns are kept so a long thread cannot blow the token budget.
 *
 * @param {Array<{ author: string; botId: string; text: string }>} posts
 * @param {{ userId?: string; botId?: string }} identity
 * @returns {Array<{ role: "user" | "assistant"; content: string }>}
 */
export function threadToTurns(posts, identity) {
  const turns = [];
  for (const post of (Array.isArray(posts) ? posts : []).slice(-MAX_THREAD_TURNS)) {
    const bot = isOurBot(post, identity);
    const text = bot ? String(post?.text ?? "").trim() : cleanMention(String(post?.text ?? ""));
    if (!text) continue;
    const role = bot ? "assistant" : "user";
    const previous = turns.at(-1);
    if (previous && previous.role === role) previous.content = `${previous.content}\n\n${text}`;
    else turns.push({ role, content: text });
  }
  // A conversation the model can answer opens on a person and ends on one; lead assistant turns are noise.
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}

/**
 * Slack accepts a large message but shows a truncated one, so an answer longer than this is cut with a
 * marker rather than sent whole and clipped invisibly. The ceiling is well under Slack's own limit,
 * leaving room for the marker and for the header the route may prepend.
 */
const SLACK_MAX_CHARS = 38_000;

/**
 * Trims an answer to Slack's practical limit, closing any open code fence so it does not swallow the marker.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncateForSlack(text, max = SLACK_MAX_CHARS) {
  const body = String(text ?? "");
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  // If the cut landed inside a code fence, an odd number of fences is open; close it so the marker shows.
  const fences = (cut.match(/```/g) ?? []).length;
  const closer = fences % 2 === 1 ? "\n```" : "";
  return `${cut}${closer}\n\n_…answer truncated for Slack. Ask for a narrower slice, or open Reply Radar for the full version._`;
}
