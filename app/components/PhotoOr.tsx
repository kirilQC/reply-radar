// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.
"use client";

import { useEffect, useState } from "react";

/**
 * A person's photo, or their initials when there is no photo or it fails to load.
 *
 * LinkedIn photo URLs are signed and expire, so a stored URL that worked when the lead was enriched can
 * 404 months later. A bare <img> then shows the browser's broken-image glyph on a coloured tile.
 */
export default function PhotoOr({ src, fallback, alt = "" }: { src?: string | null; fallback: React.ReactNode; alt?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <>{fallback}</>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} onError={() => setFailed(true)} />;
}
