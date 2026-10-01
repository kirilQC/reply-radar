// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The QC Command brand, from the master artwork rather than a redraw.
 *
 * The images in public/brand/ are cut straight out of the supplied logo — each pixel unmixed from the
 * artwork's dark background, so the edges keep their anti-aliasing and the letterforms, weight and
 * spacing are exactly the original. Two wordmark files because the "Command" half is white: the light
 * one swaps it for near-black so it reads on a light background. The icon is the dot grid alone, used
 * where there is only room for the mark (the collapsed sidebar).
 */

export const BRAND_TEAL = "#65EBE0";

/** Width / height of the cropped wordmark artwork, so a given height lays out without a reflow. */
const WORDMARK_RATIO = 1365 / 171;
const ICON_RATIO = 170 / 165;

export function BrandIcon({ size = 22, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={`brand-icon ${className ?? ""}`} src="/brand/qc-command-icon.png" alt="" aria-hidden width={Math.round(size * ICON_RATIO)} height={size} />
  );
}

export function BrandWordmark({ height = 22, className }: { height?: number; className?: string }) {
  const width = Math.round(height * WORDMARK_RATIO);
  return (
    <span className={`brand-wordmark ${className ?? ""}`} role="img" aria-label="QC Command">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="brand-wordmark-dark" src="/brand/qc-command-wordmark-dark.png" alt="" width={width} height={height} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="brand-wordmark-light" src="/brand/qc-command-wordmark-light.png" alt="" width={width} height={height} />
    </span>
  );
}
