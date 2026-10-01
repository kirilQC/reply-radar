// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The QC Command brand: the 3×3 dot-grid icon and the "QC Command" wordmark.
 *
 * Drawn rather than shipped as an image so it is sharp at every size and follows the theme — the
 * "Command" half is the page's own text colour, so it stays readable in light mode where a baked-in
 * white wordmark would vanish. The icon's last column is the dimmer teal, as in the master artwork.
 */

export const BRAND_TEAL = "#65EBE0";
export const BRAND_TEAL_DIM = "#499B8F";

export function BrandIcon({ size = 22, className }: { size?: number; className?: string }) {
  const cols = [18, 50, 82];
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden focusable="false">
      {cols.map((cy) =>
        cols.map((cx, column) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={13.5} fill={column === 2 ? BRAND_TEAL_DIM : BRAND_TEAL} />
        )),
      )}
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={`brand-wordmark ${className ?? ""}`}>
      <span className="brand-wordmark-qc">QC</span> Command
    </span>
  );
}
