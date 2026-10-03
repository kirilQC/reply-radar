// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Blanks the draft model leaves for a person to fill: "(insert time here)", "[link]". */
export const PLACEHOLDER_PATTERN =
  /\((?:insert|add|your|enter)[^)]{0,40}\)|\[(?:insert|add|your|enter|link|time|date|name)[^\]]{0,40}\]/gi;

export const firstPlaceholder = (text: string): string | null => text.match(new RegExp(PLACEHOLDER_PATTERN.source, "i"))?.[0] ?? null;

/** Text split into plain runs and blanks, for drawing the highlights. */
export function splitPlaceholders(text: string): Array<{ text: string; blank: boolean }> {
  const parts: Array<{ text: string; blank: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(PLACEHOLDER_PATTERN.source, "gi"))) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), blank: false });
    parts.push({ text: match[0], blank: true });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), blank: false });
  return parts;
}

/**
 * The draft textarea with every unfilled blank highlighted in place.
 *
 * A textarea cannot style part of its own text, so an identical layer sits behind it: same text, same
 * font, same padding, with the text itself invisible and only the blanks painted. The textarea on top is
 * transparent, so the highlight shows through exactly under the words. The layer copies the textarea's
 * computed type and spacing rather than hard-coding them, because several stylesheets set the composer.
 */
export default function DraftField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    const measure = () => {
      const style = window.getComputedStyle(element);
      setMetrics({
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight as CSSProperties["fontWeight"],
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        borderTopWidth: style.borderTopWidth,
        borderLeftWidth: style.borderLeftWidth,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const parts = splitPlaceholders(value);
  const hasBlank = parts.some((part) => part.blank);

  return (
    <div className="draft-field">
      {hasBlank && (
        <div className="draft-field-layer" ref={layer} style={metrics} aria-hidden="true">
          {parts.map((part, index) => (part.blank ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
          {"\n "}
        </div>
      )}
      <textarea
        ref={field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (layer.current) layer.current.scrollTop = event.currentTarget.scrollTop;
        }}
        placeholder={placeholder}
        aria-describedby={hasBlank ? "draft-field-blank" : undefined}
      />
      {hasBlank && (
        <span id="draft-field-blank" className="sr-only">
          The highlighted text is a blank to fill in before sending.
        </span>
      )}
    </div>
  );
}
