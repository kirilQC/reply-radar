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

import { parseBlocks as parse } from "../../shared/markdown-blocks.mjs";

export type Span =
  | { kind: "text" | "bold" | "italic" | "code"; text: string }
  | { kind: "link"; text: string; href: string };
export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Array<{ depth: number; spans: Span[] }> }
  | { kind: "table"; head: Span[][]; rows: Span[][][] }
  | { kind: "code"; language: string; text: string }
  | { kind: "rule" };

/**
 * The shape is asserted once, here, because the parser is plain `.mjs` and infers as `any[]`.
 * Everything downstream is then properly narrowed, and `tests/answer-formatting.test.mjs` is what
 * actually holds the parser to this contract.
 */
const parseBlocks = parse as (markdown: string) => Block[];

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

function Rendered({ block }: { block: Block }) {
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

export default function Markdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);
  return (
    <div className="md">
      {blocks.map((block, index) => (
        <Rendered block={block} key={index} />
      ))}
    </div>
  );
}
