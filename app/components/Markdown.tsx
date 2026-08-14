/**
 * Renders the assistant's markdown.
 *
 * The parsing lives in `shared/markdown-blocks.mjs` so it can be tested without a browser; this file
 * is only the mapping from blocks to elements. Keeping the split means a formatting bug is a unit
 * test rather than a screenshot.
 *
 * Links get `rel="noreferrer"` and open in a new tab because every link here is a LinkedIn profile
 * and losing the conversation to navigate to one would be a poor trade.
 */

"use client";

import { memo, useMemo } from "react";
import { parseBlocks as parse, splitSettled as split } from "../../shared/markdown-blocks.mjs";

export type Span =
  | { kind: "text" | "bold" | "italic" | "code"; text: string }
  | { kind: "link"; text: string; href: string };
export type ChartPoint = {
  label: string;
  note: string;
  value: number | null;
  display: string;
  fraction: number;
  negative: boolean;
  tone: string;
};
export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "callout"; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Array<{ depth: number; spans: Span[] }> }
  | { kind: "table"; head: Span[][]; rows: Span[][][] }
  | { kind: "code"; language: string; text: string; closed: boolean }
  | {
      kind: "chart";
      chart: "bar" | "column" | "split";
      title: string;
      caption: string;
      unit: string;
      hidden: number;
      series: ChartPoint[];
    }
  | { kind: "stats"; items: Array<{ label: string; value: string; note: string; tone: string }> }
  | { kind: "export"; formats: string[] }
  | { kind: "rule" };

/**
 * What an `export` block does when clicked, and which answer it belongs to.
 *
 * Threaded as two stable values rather than one closure per message because a fresh arrow function
 * per render would defeat the memo below, which is the whole reason a long answer types smoothly.
 */
export type ExportHandler = (key: number, format: string) => void;
type Wiring = { onExport?: ExportHandler; exportKey?: number };

/**
 * The shape is asserted once, here, because the parser is plain `.mjs` and infers as `any[]`.
 * Everything downstream is then properly narrowed, and `tests/answer-formatting.test.mjs` is what
 * actually holds the parser to this contract.
 */
const parseBlocks = parse as (markdown: string) => Block[];
const splitSettled = split as (markdown: string) => { settled: string; tail: string };

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) => {
        if (span.kind === "bold") return <strong key={index}>{span.text}</strong>;
        if (span.kind === "italic") return <em key={index}>{span.text}</em>;
        if (span.kind === "code") return <code key={index}>{span.text}</code>;
        if (span.kind === "link") {
          return (
            <a key={index} href={span.href} target="_blank" rel="noreferrer">
              {span.text}
            </a>
          );
        }
        return <span key={index}>{span.text}</span>;
      })}
    </>
  );
}

/** A fraction as a CSS length. Kept off zero so a real but tiny value still shows something. */
const track = (fraction: number) => `${fraction > 0 ? Math.max(fraction * 100, 1.5) : 0}%`;

/** The spec's own tone if it gave one, otherwise coral for anything below zero. */
const toneOf = (point: { tone: string; negative: boolean }) => point.tone || (point.negative ? "negative" : "");

function Chart({ block }: { block: Extract<Block, { kind: "chart" }> }) {
  const { series, chart } = block;
  return (
    <figure className="md-chart" data-chart={chart}>
      {(block.title || block.caption) && (
        <figcaption>
          {block.title && <strong>{block.title}</strong>}
          {block.caption && <span>{block.caption}</span>}
        </figcaption>
      )}

      {chart === "column" && (
        <div className="md-columns">
          {series.map((point, index) => (
            <div key={index} data-tone={toneOf(point) || undefined}>
              <strong>{point.display}</strong>
              <i style={{ height: track(point.fraction) }} />
              <small title={point.label}>{point.label}</small>
            </div>
          ))}
        </div>
      )}

      {chart === "split" && (
        <>
          <div className="md-split">
            {series.map((point, index) => (
              <em key={index} data-slot={index % 5} style={{ width: track(point.fraction) }} />
            ))}
          </div>
          <ul className="md-split-legend">
            {series.map((point, index) => (
              <li key={index}>
                <i data-slot={index % 5} />
                <span>{point.label}</span>
                <data>{point.display}</data>
              </li>
            ))}
          </ul>
        </>
      )}

      {chart === "bar" && (
        <div className="md-bars">
          {series.map((point, index) => (
            <div className="md-bar" key={index}>
              <span title={point.label}>
                {point.label}
                {point.note && <small>{point.note}</small>}
              </span>
              <i>
                <em style={{ width: track(point.fraction) }} data-tone={toneOf(point) || undefined} />
              </i>
              <data>{point.display}</data>
            </div>
          ))}
        </div>
      )}

      {/* Never silently truncated: a top-twelve shown as if it were everything is a wrong answer. */}
      {block.hidden > 0 && <p className="md-chart-more">+{block.hidden} more not shown</p>}
    </figure>
  );
}

const FORMAT_LABEL: Record<string, string> = { csv: "Download CSV", pdf: "Download PDF" };

function Rendered({ block, live, onExport, exportKey }: { block: Block; live: boolean } & Wiring) {
  if (block.kind === "chart") return <Chart block={block} />;
  if (block.kind === "export") {
    // Nothing to click when there is no handler — an answer printed to PDF or copied out should not
    // carry a dead button into the file.
    if (!onExport || exportKey === undefined) return null;
    return (
      <div className="md-export print-hide">
        {block.formats.map((format) => (
          <button key={format} type="button" onClick={() => onExport(exportKey, format)}>
            {FORMAT_LABEL[format] ?? format.toUpperCase()}
          </button>
        ))}
      </div>
    );
  }
  // A visual still arriving. Shown as a placeholder rather than as the JSON it currently is, and only
  // while the turn is live — once the answer is finished, an unreadable spec goes back to being
  // visible code, because then it is a real defect and hiding it would hide the numbers with it.
  if (live && block.kind === "code" && !block.closed && (block.language === "chart" || block.language === "stats")) {
    return <p className="md-drawing">Drawing {block.language === "stats" ? "figures" : "chart"}…</p>;
  }
  if (block.kind === "stats") {
    return (
      <div className="md-stats">
        {block.items.map((item, index) => (
          <div key={index} data-tone={item.tone || undefined}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            {item.note && <small>{item.note}</small>}
          </div>
        ))}
      </div>
    );
  }
  if (block.kind === "callout") {
    return (
      <aside className="md-callout">
        <Spans spans={block.spans} />
      </aside>
    );
  }
  if (block.kind === "heading") {
    // Clamped to h3–h5. The page already owns h1 and h2, and an answer that opens with an h1 would
    // outrank the page title it sits under.
    const Tag = (["h3", "h3", "h3", "h4", "h5", "h5"] as const)[block.level - 1] ?? "h4";
    return (
      <Tag>
        <Spans spans={block.spans} />
      </Tag>
    );
  }
  if (block.kind === "paragraph") {
    return (
      <p>
        <Spans spans={block.spans} />
      </p>
    );
  }
  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag>
        {block.items.map((item, index) => (
          <li key={index} data-depth={item.depth}>
            <Spans spans={item.spans} />
          </li>
        ))}
      </Tag>
    );
  }
  if (block.kind === "table") {
    return (
      // Wrapped so a wide table scrolls inside the answer instead of stretching the whole column.
      <div className="md-table-wrap">
        <table>
          <thead>
            <tr>
              {block.head.map((cell, index) => (
                <th key={index}>
                  <Spans spans={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((cells, rowIndex) => (
              <tr key={rowIndex}>
                {cells.map((cell, index) => (
                  <td key={index}>
                    <Spans spans={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.kind === "code") {
    return (
      <pre>
        <code>{block.text}</code>
      </pre>
    );
  }
  return <hr />;
}

/**
 * A run of markdown as elements, memoised on the source text.
 *
 * Returning a fragment rather than a wrapper keeps every block a direct child of `.md`, which the
 * first-child and last-child margin rules depend on.
 */
const Blocks = memo(function Blocks({ markdown, live, onExport, exportKey }: { markdown: string; live: boolean } & Wiring) {
  const blocks = useMemo(() => parseBlocks(markdown), [markdown]);
  return (
    <>
      {blocks.map((block, index) => (
        <Rendered block={block} live={live} onExport={onExport} exportKey={exportKey} key={index} />
      ))}
    </>
  );
});

/**
 * `live` means the turn is still streaming, which changes two things.
 *
 * The visible one is how an unfinished block is shown. The one that matters more is that a streaming
 * answer is split at the last blank line and rendered as two runs, because the cost of typing an
 * answer out is not parsing it — it is React re-diffing everything already on screen sixty times a
 * second. A finished forty-row table is a thousand-odd fibers, and re-checking all of them on every
 * frame is what made long answers crawl while short ones felt fine.
 *
 * Splitting turns that into a bail-out: the settled run's only prop is a string that does not change
 * between blank lines, so React skips it entirely and each frame only touches the paragraph or the
 * handful of rows still being written. The settled run re-renders once per completed block instead of
 * once per frame.
 *
 * The outer memo covers the same problem across turns: the page re-renders on every painted frame, so
 * without it, asking a tenth question would re-parse the previous nine answers for as long as the
 * tenth took to arrive — lag that grew with the transcript rather than with the answer.
 */
const Markdown = memo(function Markdown({
  children,
  live = false,
  onExport,
  exportKey,
}: { children: string; live?: boolean } & Wiring) {
  const { settled, tail } = useMemo(
    () => (live ? splitSettled(children) : { settled: "", tail: children }),
    [children, live],
  );
  return (
    <div className="md">
      {/* Never live: `splitSettled` will not cut inside an open fence, so nothing here is unfinished. */}
      {settled ? <Blocks markdown={settled} live={false} onExport={onExport} exportKey={exportKey} /> : null}
      <Blocks markdown={tail} live={live} onExport={onExport} exportKey={exportKey} />
    </div>
  );
});

export default Markdown;
