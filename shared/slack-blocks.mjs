// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A QC Bot answer (the assistant's markdown) as Slack Block Kit, in the one house layout:
 *
 *   1 Verdict   the bold opening line, as a header (or a bold section when it is too long for one)
 *   2 Numbers   the ```stats tiles, as a two-column grid of figures
 *   3 Detail    lists as two-line items (bold first line, grey detail line, optional priority dot),
 *               narrow tables kept as tables, short paragraphs
 *   4 Actions   follow-up questions (```actions) and QC Command links, as buttons
 *   5 Footer    sources, date range, freshness and run time, small and grey
 *
 * Anything it cannot place falls back to plain mrkdwn sections, and the caller keeps the text version for
 * notifications and as the fallback if Slack refuses the blocks.
 */

import { inlineToMrkdwn, toSlackText } from "./slack-agent.mjs";

const MAX_BLOCKS = 48;
const SECTION_MAX = 2900;
const HEADER_MAX = 150;
export const ASK_ACTION = "qcbot_ask";

const plain = (s) => String(s ?? "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
const mrk = (s) => inlineToMrkdwn(String(s ?? ""));
const section = (text) => ({ type: "section", text: { type: "mrkdwn", text: String(text).slice(0, SECTION_MAX) } });
const context = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text: String(text).slice(0, SECTION_MAX) }] });

/** Splits "**Name**, Company (Client) · detail" into a first line and a detail line. */
function splitItem(raw) {
  const text = String(raw).trim();
  const dot = text.match(/^(\p{Extended_Pictographic}|:[a-z_]+:)\s*/u);
  const marker = dot ? dot[1] : "";
  const body = dot ? text.slice(dot[0].length) : text;
  // The first " · ", " - " or ": " after a bold lead separates the name from its detail.
  const label = body.match(/^\*\*([^*]{1,60}?):\*\*\s*(.+)$/s) || body.match(/^\*\*([^*]{1,60}?)\*\*:\s*(.+)$/s);
  if (label) return { marker, head: `**${label[1].trim()}**`, detail: label[2].trim() };
  const sep = body.match(/^(\*\*[^*]+\*\*[^·:–—-]{0,80}?)\s*(?:·|:|–|—|\s-\s)\s*(.+)$/u);
  if (sep) return { marker, head: sep[1].trim(), detail: sep[2].trim() };
  return { marker, head: body, detail: "" };
}

/** Footer-ish lines: the HeyReach stamp, "Answered in", caveats written wholly in italics. */
const isFooterLine = (line) => /^_[^_].*_$/.test(line.trim()) || /^\*[^*].*\*$/.test(line.trim()) && !/^\*\*/.test(line.trim());

/**
 * @param {string} markdown
 * @param {{ footer?: string[] }} [opts]
 * @returns {{ blocks: object[] | null, text: string, verdict: string }}
 */
export function answerToBlocks(markdown, opts = {}) {
  const footer = Array.isArray(opts.footer) ? opts.footer : [];
  const lines = String(markdown ?? "").replace(/\r/g, "").split("\n");
  const blocks = [];
  const footerBits = [];
  const buttons = [];
  let verdictText = "";

  // 1. Verdict: the first non-empty paragraph, when it opens in bold.
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  const firstPara = [];
  while (i < lines.length && lines[i].trim() && !/^(```|#|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) { firstPara.push(lines[i]); i += 1; }
  const para = firstPara.join(" ").trim();
  const bold = para.match(/^\*\*(.+?)\*\*\s*(.*)$/s);
  if (bold) {
    const full = plain(bold[1]);
    // The header is the first sentence; any further sentences of the verdict sit under it in bold.
    const first = full.match(/^.+?[.!?](?=\s+[A-Z0-9]|$)/)?.[0] ?? full;
    verdictText = first.length <= HEADER_MAX ? first : full;
    const restOfVerdict = verdictText === full ? "" : full.slice(first.length).trim();
    if (verdictText.length <= HEADER_MAX) blocks.push({ type: "header", text: { type: "plain_text", text: verdictText, emoji: true } });
    else blocks.push(section(`*${verdictText}*`));
    const after = [restOfVerdict ? `*${restOfVerdict}*` : "", bold[2].trim() ? mrk(bold[2].trim()) : ""].filter(Boolean).join(" ");
    if (after) blocks.push(section(after));
  } else if (para) {
    verdictText = plain(para).slice(0, 200);
    blocks.push(section(mrk(para)));
  }

  // 2 + 3. The rest, in order.
  let pendingText = [];
  const flushText = () => {
    const t = pendingText.join("\n").trim();
    if (t) blocks.push(section(toSlackText(t)));
    pendingText = [];
  };
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^```\s*(\w+)?\s*$/);
    if (fence) {
      flushText();
      const lang = (fence[1] || "").toLowerCase();
      const body = [];
      for (i += 1; i < lines.length && !/^```\s*$/.test(lines[i]); i += 1) body.push(lines[i]);
      if (lang === "stats") {
        try {
          const items = (JSON.parse(body.join("\n")).items || []).slice(0, 10);
          if (items.length) blocks.push({ type: "section", fields: items.map((it) => ({ type: "mrkdwn", text: `*${plain(it.value)}*\n${plain(it.label)}${it.note ? ` · ${plain(it.note)}` : ""}`.slice(0, 1900) })) });
        } catch { /* malformed tiles are dropped */ }
      } else if (lang === "actions") {
        try {
          const asks = JSON.parse(body.join("\n"));
          for (const ask of (Array.isArray(asks) ? asks : []).slice(0, 3)) {
            const label = plain(typeof ask === "string" ? ask : ask?.label);
            if (label) buttons.push({ type: "button", text: { type: "plain_text", text: label.slice(0, 75), emoji: true }, action_id: `${ASK_ACTION}_${buttons.length}`, value: label.slice(0, 1900) });
          }
        } catch { /* not JSON: ignore */ }
      } else if (["chart", "map", "cards", "timeline", "export"].includes(lang)) {
        // Visuals Slack cannot draw; the numbers are in the text around them.
      } else {
        blocks.push(section("```" + body.join("\n").slice(0, SECTION_MAX - 10) + "```"));
      }
      continue;
    }
    // A list run: two-line items.
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushText();
      const run = [];
      for (; i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && run.length)); i += 1) {
        if (/^\s{2,}([-*+]|\d+[.)])\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i])) { run[run.length - 1] += ` · ${lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, "")}`; continue; }
        run.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      }
      i -= 1;
      const numbered = /^\s*\d+[.)]/.test(line);
      run.forEach((item, n) => {
        const { marker, head, detail } = splitItem(item);
        const lead = marker ? `${marker}  ` : numbered ? `${n + 1}.  ` : "•  ";
        blocks.push(section(`${lead}${mrk(head)}`));
        if (detail) blocks.push(context(mrk(detail)));
      });
      continue;
    }
    // Links to QC Command become buttons.
    const link = line.trim().match(/^\[([^\]]+)\]\(<?(https?:[^)>\s]+)>?\)\s*$/);
    if (link) {
      flushText();
      buttons.push({ type: "button", text: { type: "plain_text", text: plain(link[1]).replace(/\s*[→>]+\s*$/, "").slice(0, 75), emoji: true }, url: link[2], action_id: `qcbot_link_${buttons.length}` });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) { flushText(); blocks.push(section(`*${plain(line.replace(/^#{1,6}\s+/, ""))}*`)); continue; }
    if (isFooterLine(line)) { flushText(); footerBits.push(mrk(line.trim())); continue; }
    if (/^>\s?/.test(line)) { flushText(); blocks.push(context(mrk(line.replace(/^>\s?/, "")))); continue; }
    if (!line.trim()) { flushText(); continue; }
    // A closing offer ("Want the per-campaign breakdown, or the leads behind Hetz's 44?") becomes buttons.
    const offer = line.trim().match(/^(?:want|would you like|should i|shall i|do you want)\b(?: me to)?(?: (?:pull|see|get|show|run))?\s*(?:the\s)?(.+)\?$/i);
    if (offer && !lines.slice(i + 1).some((l) => l.trim() && !isFooterLine(l) && !/^```/.test(l) && !/^\[/.test(l.trim()))) {
      flushText();
      for (const option of offer[1].split(/,\s*(?:or\s+)?|\s+or\s+/i).map((o) => plain(o).trim()).filter(Boolean).slice(0, 3)) {
        const label = option.charAt(0).toUpperCase() + option.slice(1);
        buttons.push({ type: "button", text: { type: "plain_text", text: label.slice(0, 75), emoji: true }, action_id: `${ASK_ACTION}_${buttons.length}`, value: label.slice(0, 1900) });
      }
      continue;
    }
    pendingText.push(line);
  }
  flushText();

  // 4. Actions.
  if (buttons.length) {
    const firstAsk = buttons.findIndex((b) => !b.url);
    if (firstAsk >= 0) buttons[firstAsk].style = "primary";
    blocks.push({ type: "actions", elements: buttons.slice(0, 5) });
  }
  // 5. Footer.
  const foot = [...footerBits, ...footer.map((f) => String(f))].filter(Boolean);
  if (foot.length) blocks.push(context(foot.join("  ·  ")));

  if (blocks.length > MAX_BLOCKS) return { blocks: null, text: toSlackText(markdown), verdict: verdictText };
  return { blocks, text: verdictText || toSlackText(markdown).slice(0, 300), verdict: verdictText };
}
