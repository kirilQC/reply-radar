// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { Fragment } from "react";
import { parseSlackBrief, type BriefBlock, type InlineNode } from "../lib/brief-format";

/**
 * The brief on the website, read as a document rather than proofread as markup.
 *
 * Slack gets the raw mrkdwn — that is the thing being sent and the thing worth checking there. Here the
 * same stored string is turned back into headings, lists and callouts by `parseSlackBrief`, and this
 * component only decides which tag each block becomes. Consecutive bullets are gathered into one list so
 * the browser draws the markers; everything else is a block in its own right, in the order the brief
 * wrote it.
 *
 * `mentions` maps the `<@U…>` codes the brief is written in to names. Without it every mention would show
 * as a raw id, so the run hands it down from the same roster the brief was told to mention people from.
 */
export default function BriefView({ body, mentions = {} }: { body: string; mentions?: Record<string, string> }) {
  const blocks = parseSlackBrief(body, mentions);
  if (!blocks.length) return null;

  return <div className="brief-doc">{renderBlocks(blocks)}</div>;
}

/** Walk the blocks, folding each run of adjacent bullets into a single list as it goes. */
function renderBlocks(blocks: BriefBlock[]) {
  const out: React.ReactNode[] = [];
  let bullets: Array<Extract<BriefBlock, { type: "bullet" }>> = [];

  const flushBullets = () => {
    if (!bullets.length) return;
    out.push(<BulletList key={`ul-${out.length}`} items={bullets} />);
    bullets = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === "bullet") {
      bullets.push(block);
      return;
    }
    flushBullets();
    const key = `b-${index}`;
    if (block.type === "heading") {
      out.push(
        <h3 className="brief-doc-heading" key={key}>
          <span className="brief-doc-heading-mark" aria-hidden>{block.glyph}</span>
          <span>{renderInline(block.title)}</span>
        </h3>,
      );
    } else if (block.type === "callout") {
      out.push(
        <p className="brief-doc-callout" key={key}>
          <span className="brief-doc-callout-mark" aria-hidden>{block.glyph}</span>
          <span>{renderInline(block.children)}</span>
        </p>,
      );
    } else if (block.type === "numbered") {
      out.push(
        <p className="brief-doc-numbered" key={key}>
          <span className="brief-doc-number">{block.number}.</span>
          <span>{renderInline(block.children)}</span>
        </p>,
      );
    } else {
      out.push(<p className="brief-doc-paragraph" key={key}>{renderInline(block.children)}</p>);
    }
  });

  flushBullets();
  return out;
}

/** A run of bullets as one list, each item carrying its own nesting depth as a data attribute for CSS. */
function BulletList({ items }: { items: Array<Extract<BriefBlock, { type: "bullet" }>> }) {
  return (
    <ul className="brief-doc-list">
      {items.map((item, index) => (
        <li className="brief-doc-item" data-depth={item.depth} key={index}>
          {renderInline(item.children)}
        </li>
      ))}
    </ul>
  );
}

/** Inline spans to React nodes: bold and italic recurse, the rest are leaves. */
function renderInline(nodes: InlineNode[]): React.ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.value}</Fragment>;
      case "bold":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "italic":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "emoji":
        return <span className="brief-doc-emoji" key={index}>{node.glyph}</span>;
      case "mention":
        return <span className="brief-doc-mention" key={index}>@{node.name}</span>;
      case "link":
        return (
          <a className="brief-doc-link" href={node.href} target="_blank" rel="noreferrer" key={index}>
            {node.label}
          </a>
        );
      default:
        return null;
    }
  });
}
