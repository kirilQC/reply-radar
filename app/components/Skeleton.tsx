// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * The one loading state for the whole app: soft shimmering placeholders in the shape of what is about
 * to arrive, instead of the word "Loading…" and then a sudden pop. Each variant sketches a real layout
 * (a card grid, a board, a list, stat tiles, a document), so the page keeps its shape while it loads and
 * the real content fades in on top of where the placeholders were.
 *
 * Usage: `{loading ? <Skeleton variant="cards" /> : <div className="rr-appear">…</div>}`.
 * `rr-appear` is the matching fade-in for whatever replaces it.
 */

type Variant = "cards" | "logo-cards" | "board" | "list" | "stats" | "doc" | "table" | "lines";

type Props = {
  variant?: Variant;
  /** How many items to sketch. Each variant has a sensible default. */
  count?: number;
  /** Accessible name for what is loading, e.g. "Loading deals". */
  label?: string;
  className?: string;
};

const Bar = ({ w, h = 10, r = 6 }: { w: string | number; h?: number; r?: number }) => (
  <span className="rr-skel-bar" style={{ width: typeof w === "number" ? `${w}%` : w, height: h, borderRadius: r }} />
);

// Widths vary a little row to row so the placeholders read as text, not a barcode.
const widths = [72, 58, 84, 64, 77, 52, 68, 81, 60, 74];

export default function Skeleton({ variant = "cards", count, label = "Loading", className = "" }: Props) {
  const n = count ?? { cards: 6, "logo-cards": 8, board: 4, list: 7, stats: 4, doc: 9, table: 8, lines: 3 }[variant];
  const items = Array.from({ length: n }, (_, i) => i);

  let body: React.ReactNode;
  switch (variant) {
    case "logo-cards":
      body = (
        <div className="rr-skel-grid rr-skel-grid-logo">
          {items.map((i) => (
            <div className="rr-skel-card" key={i} style={{ ["--i" as string]: i }}>
              <span className="rr-skel-bar rr-skel-logo" />
              <Bar w={widths[i % widths.length] - 20} h={12} />
              <Bar w={widths[(i + 3) % widths.length] - 35} h={8} />
            </div>
          ))}
        </div>
      );
      break;
    case "board":
      body = (
        <div className="rr-skel-board">
          {items.map((col) => (
            <div className="rr-skel-col" key={col} style={{ ["--i" as string]: col }}>
              <div className="rr-skel-col-head"><span className="rr-skel-bar rr-skel-logo rr-skel-logo-sm" /><Bar w={45} h={12} /></div>
              {[0, 1, 2].slice(0, 3 - (col % 2)).map((k) => (
                <div className="rr-skel-card rr-skel-task" key={k}>
                  <Bar w={30} h={8} />
                  <Bar w={widths[(col + k) % widths.length]} h={12} />
                  <Bar w={widths[(col + k + 4) % widths.length] - 10} h={8} />
                  <div className="rr-skel-row"><span className="rr-skel-bar rr-skel-dot" /><Bar w={28} h={8} /></div>
                </div>
              ))}
            </div>
          ))}
        </div>
      );
      break;
    case "list":
      body = (
        <div className="rr-skel-list">
          {items.map((i) => (
            <div className="rr-skel-item" key={i} style={{ ["--i" as string]: i }}>
              <span className="rr-skel-bar rr-skel-avatar" />
              <div className="rr-skel-stack">
                <Bar w={widths[i % widths.length] - 30} h={12} />
                <Bar w={widths[(i + 5) % widths.length] - 10} h={8} />
              </div>
              <Bar w="54px" h={10} />
            </div>
          ))}
        </div>
      );
      break;
    case "table":
      body = (
        <div className="rr-skel-table">
          <div className="rr-skel-trow rr-skel-thead">{[22, 14, 12, 18].map((w, k) => <Bar key={k} w={w} h={8} />)}</div>
          {items.map((i) => (
            <div className="rr-skel-trow" key={i} style={{ ["--i" as string]: i }}>
              <div className="rr-skel-row"><span className="rr-skel-bar rr-skel-avatar rr-skel-avatar-sm" /><Bar w={widths[i % widths.length] - 25} h={10} /></div>
              <Bar w={widths[(i + 2) % widths.length] - 30} h={10} />
              <Bar w={40} h={10} />
              <Bar w={widths[(i + 6) % widths.length] - 20} h={10} />
            </div>
          ))}
        </div>
      );
      break;
    case "stats":
      body = (
        <div className="rr-skel-stats">
          {items.map((i) => (
            <div className="rr-skel-card rr-skel-stat" key={i} style={{ ["--i" as string]: i }}>
              <Bar w={55} h={8} />
              <Bar w={38} h={26} r={8} />
              <Bar w={45} h={8} />
            </div>
          ))}
        </div>
      );
      break;
    case "doc":
      body = (
        <div className="rr-skel-doc">
          <Bar w={42} h={22} r={8} />
          {items.map((i) => <Bar key={i} w={i % 4 === 3 ? 48 : widths[i % widths.length] + 15} h={10} />)}
        </div>
      );
      break;
    case "lines":
      body = <div className="rr-skel-doc rr-skel-lines">{items.map((i) => <Bar key={i} w={widths[i % widths.length]} h={10} />)}</div>;
      break;
    default:
      body = (
        <div className="rr-skel-grid">
          {items.map((i) => (
            <div className="rr-skel-card" key={i} style={{ ["--i" as string]: i }}>
              <div className="rr-skel-row"><span className="rr-skel-bar rr-skel-logo rr-skel-logo-sm" /><Bar w={45} h={12} /></div>
              <Bar w={widths[i % widths.length]} h={10} />
              <Bar w={widths[(i + 4) % widths.length] - 20} h={10} />
            </div>
          ))}
        </div>
      );
  }

  return (
    <div className={`rr-skel ${className}`} role="status" aria-live="polite" aria-label={label}>
      {body}
    </div>
  );
}
