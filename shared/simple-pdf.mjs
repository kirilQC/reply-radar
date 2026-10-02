// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A report answer (the assistant's markdown) as a real PDF, with no dependency.
 *
 * Scout makes its PDFs through the browser's print dialog; QC Bot in Slack has no browser, so this writes
 * the file directly: Letter pages, the standard Helvetica faces (no font embedding), headings, paragraphs,
 * bullets, quotes, tables and the `stats` tiles as a numbers list. Charts and other visuals are skipped;
 * the prose and tables around them carry the same numbers.
 */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const WIDTH = PAGE_W - MARGIN * 2;

const FONTS = { regular: "F1", bold: "F2", italic: "F3", mono: "F4" };
// Average glyph width as a share of the font size. Rough, but wrapping only needs to be close.
const WIDTH_FACTOR = { regular: 0.5, bold: 0.55, italic: 0.5, mono: 0.6 };

/** Characters Helvetica's WinAnsi encoding lacks, mapped to the nearest it has. */
function toWinAnsi(input) {
  return String(input ?? "")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[•●]/g, "\u0095")
    .replace(/ /g, " ")
    .replace(/[←-⇿]/g, (c) => ({ "→": "->", "←": "<-", "↑": "up", "↓": "down" })[c] ?? "")
    .replace(/[^\x00-\xFF\u0095]/g, "");
}

const escapePdf = (s) => toWinAnsi(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Markdown inline marks reduced to plain text: `**b**`, `_i_`, `` `c` ``, `[label](url)`. */
export function plainInline(s) {
  return String(s ?? "")
    .replace(/\[([^\]]+)\]\(<?([^)>]+)>?\)/g, (_, label, url) => (/^https?:/.test(url) ? `${label} (${url})` : label))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}

function wrap(text, size, face, width) {
  const per = size * WIDTH_FACTOR[face];
  const max = Math.max(8, Math.floor(width / per));
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if ((line + " " + word).length <= max) line += " " + word;
      else { out.push(line); line = word; }
      while (line.length > max) { out.push(line.slice(0, max)); line = line.slice(max); }
    }
    out.push(line);
  }
  return out;
}

/** Parses the answer into simple layout blocks. */
function blocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r/g, "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^```\s*(\w+)?/);
    if (fence) {
      const lang = (fence[1] || "").toLowerCase();
      const body = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i]); i += 1) body.push(lines[i]);
      if (lang === "stats") {
        try {
          const spec = JSON.parse(body.join("\n"));
          const items = Array.isArray(spec.items) ? spec.items : [];
          if (items.length) out.push({ kind: "stats", items: items.map((it) => ({ label: plainInline(it.label), value: plainInline(it.value), note: plainInline(it.note || "") })) });
        } catch { /* a malformed tile block is skipped */ }
      } else if (!lang || ["text", "txt", "code", "plain"].includes(lang)) {
        out.push({ kind: "code", lines: body });
      }
      // chart, map, cards, timeline, export: not drawable here.
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i += 1) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => plainInline(c.trim()));
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
        rows.push(cells);
      }
      i -= 1;
      if (rows.length) out.push({ kind: "table", rows });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { out.push({ kind: "heading", level: heading[1].length, text: plainInline(heading[2]) }); continue; }
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const marker = /\d/.test(bullet[2]) ? bullet[2] : "\u0095";
      out.push({ kind: "bullet", indent: Math.min(3, Math.floor(bullet[1].length / 2)), marker, text: plainInline(bullet[3]), bold: /^\*\*[^*]+\*\*/.test(bullet[3]) });
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { out.push({ kind: "quote", text: plainInline(quote[1]) }); continue; }
    if (!line.trim()) { out.push({ kind: "gap" }); continue; }
    if (/^_[^_].*_$/.test(line.trim()) || /^\*[^*].*\*$/.test(line.trim())) { out.push({ kind: "para", text: plainInline(line.trim().slice(1, -1)), face: "italic" }); continue; }
    const whollyBold = /^\*\*[^*]+\*\*[.:!?]?$/.test(line.trim());
    out.push({ kind: "para", text: plainInline(line), face: whollyBold ? "bold" : "regular" });
  }
  return out;
}

/** A PDF of the answer, as bytes. `title` heads page one; `subtitle` (e.g. the date) sits under it. */
export function markdownToPdf(markdown, { title = "Report", subtitle = "" } = {}) {
  // A report that opens with its own top heading uses it as the title rather than printing two.
  const firstHeading = String(markdown ?? "").match(/^\s*#\s+(.+)\n/);
  if (firstHeading) { title = plainInline(firstHeading[1]); markdown = String(markdown).slice(firstHeading[0].length); }
  const pages = [];
  let ops = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = PAGE_H - MARGIN; };
  const need = (h) => { if (y - h < MARGIN) newPage(); };
  const text = (x, size, face, s, gray = 0) => {
    ops.push(`BT /${FONTS[face]} ${size} Tf ${gray} g ${x.toFixed(1)} ${y.toFixed(1)} Td (${escapePdf(s)}) Tj ET`);
  };
  const rule = (x1, x2, gray = 0.8) => ops.push(`${gray} G 0.6 w ${x1} ${y.toFixed(1)} m ${x2} ${y.toFixed(1)} l S`);
  const paragraph = (s, { size = 10.5, face = "regular", indent = 0, lead = 1.4, gray = 0 } = {}) => {
    for (const l of wrap(s, size, face, WIDTH - indent)) { need(size * lead); y -= size * lead; text(MARGIN + indent, size, face, l, gray); }
  };

  // Title block.
  y -= 20; text(MARGIN, 20, "bold", title);
  if (subtitle) { y -= 16; text(MARGIN, 10, "regular", subtitle, 0.4); }
  y -= 10; rule(MARGIN, PAGE_W - MARGIN, 0.75); y -= 6;

  let lastGap = false;
  for (const b of blocks(markdown)) {
    if (b.kind === "gap") { if (!lastGap) y -= 6; lastGap = true; continue; }
    lastGap = false;
    if (b.kind === "heading") {
      const size = b.level === 1 ? 16 : b.level === 2 ? 13.5 : 11.5;
      need(size * 2.4); y -= size * 0.8; paragraph(b.text, { size, face: "bold", lead: 1.3 }); y -= 2;
    } else if (b.kind === "para") {
      paragraph(b.text, { face: b.face });
    } else if (b.kind === "quote") {
      paragraph(b.text, { face: "italic", indent: 14, gray: 0.3 });
    } else if (b.kind === "bullet") {
      const indent = 14 + b.indent * 14;
      const lines = wrap(b.text, 10.5, b.bold ? "bold" : "regular", WIDTH - indent - 4);
      lines.forEach((l, n) => {
        need(14.7); y -= 14.7;
        if (n === 0) text(MARGIN + indent - 11, 10.5, "regular", b.marker === "\u0095" ? "\u0095" : b.marker);
        text(MARGIN + indent + (b.marker === "\u0095" ? 0 : 4), 10.5, "regular", l);
      });
    } else if (b.kind === "stats") {
      for (const it of b.items) {
        need(15); y -= 15;
        text(MARGIN + 4, 12, "bold", it.value);
        const vx = MARGIN + 4 + Math.max(60, String(it.value).length * 12 * 0.56 + 10);
        text(vx, 10.5, "regular", it.label + (it.note ? `  (${it.note})` : ""), 0.25);
      }
      y -= 6;
    } else if (b.kind === "code") {
      for (const l of b.lines) for (const w of wrap(l || " ", 9, "mono", WIDTH - 8)) { need(12); y -= 12; text(MARGIN + 8, 9, "mono", w, 0.15); }
    } else if (b.kind === "table") {
      const cols = Math.max(...b.rows.map((r) => r.length));
      const longest = Array.from({ length: cols }, (_, c) => Math.min(48, Math.max(4, ...b.rows.map((r) => String(r[c] ?? "").length))));
      const total = longest.reduce((a, n) => a + n, 0);
      const widths = longest.map((n) => (n / total) * WIDTH);
      const size = cols > 5 ? 8.5 : 9.5;
      y -= 4;
      b.rows.forEach((row, r) => {
        const face = r === 0 ? "bold" : "regular";
        const cellLines = widths.map((w, c) => wrap(String(row[c] ?? ""), size, face, w - 6).slice(0, 4));
        const height = Math.max(...cellLines.map((l) => l.length)) * size * 1.3 + 4;
        need(height);
        const top = y;
        cellLines.forEach((lines, c) => {
          const x = MARGIN + widths.slice(0, c).reduce((a, n) => a + n, 0);
          lines.forEach((l, n) => { y = top - (n + 1) * size * 1.3; text(x, size, face, l); });
        });
        y = top - height;
        rule(MARGIN, PAGE_W - MARGIN, r === 0 ? 0.55 : 0.88);
      });
      y -= 8;
    }
  }
  newPage();

  // Page numbers.
  pages.forEach((p, n) => p.push(`BT /F1 8 Tf 0.5 g ${PAGE_W - MARGIN - 40} ${MARGIN / 2} Td (Page ${n + 1} of ${pages.length}) Tj ET`));

  // Assemble the file: catalog, pages tree, fonts, then a page + content stream per page.
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesId = add(null);
  const fontIds = {
    F1: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    F2: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
    F3: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>"),
    F4: add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"),
  };
  const fontDict = Object.entries(fontIds).map(([k, id]) => `/${k} ${id} 0 R`).join(" ");
  const pageIds = pages.map((p) => {
    const stream = p.join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${fontDict} >> >> /Contents ${contentId} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objects.forEach((obj, n) => { offsets.push(Buffer.byteLength(body, "latin1")); body += `${n + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

/** Whether an answer ends with the export block asking for a PDF. */
export function wantsPdf(markdown) {
  return /```\s*export\s*\n[^`]*pdf[^`]*```/i.test(String(markdown ?? ""));
}

/**
 * The top of a report for the chat message that carries its PDF: everything up to the first section
 * heading after the opening (the title and the bold verdict), plus a pointer to the file.
 */
export function reportSummary(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const out = [];
  let seenText = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && seenText) break;
    if (/^```/.test(line) && seenText) break;
    if (/^\s*\|/.test(line)) break;
    if (line.trim() && !/^#{1,6}\s/.test(line)) seenText = true;
    out.push(line);
    if (out.join("\n").length > 900) break;
  }
  return `${out.join("\n").trim()}\n\n_The full report is in the PDF below._`;
}
