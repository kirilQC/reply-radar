// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useLayoutEffect } from "react";
import {
  identityKey,
  readCachedAppearance,
  readCachedAppearanceEntry,
  writeCachedAppearance,
} from "../lib/preference-identity";

type Appearance = Record<string, unknown>;

const apply = (appearance: Appearance) => {
  const root = document.documentElement;
  const mode = String(appearance.mode || "midnight");
  root.style.setProperty("--accent", String(appearance.accent || "#8b7cff"));
  root.style.setProperty(
    "--font",
    String(appearance.font || "Inter, ui-sans-serif, system-ui, sans-serif"),
  );
  root.style.setProperty(
    "--reply-radar-zoom",
    String((Number(appearance.zoom) || 100) / 100),
  );
  root.dataset.appearanceMode = mode;
  document.body.classList.toggle("light-mode", mode === "light");
  // Every background preset is a dark plate, so light mode keeps the stylesheet's surface.
  if (mode === "light") root.style.removeProperty("--bg");
  else root.style.setProperty("--bg", String(appearance.background || "#0b0c10"));
};

export default function PreferenceBootstrap() {
  useLayoutEffect(() => {
    document.documentElement.classList.add("hydrated");
  }, []);
  useEffect(() => {
    const cached = readCachedAppearanceEntry();
    if (cached) apply(cached.appearance);
    let cancelled = false;
    // Asked for only when this browser has no cache of its own for this identity. That covers
    // the same person on a second machine, and the shared-browser case where the cache we just
    // applied belongs to whoever used it last rather than to the profile now open.
    if (!cached?.exact)
      fetch(
        `/api/preferences?identity=${encodeURIComponent(identityKey())}&legacy=general`,
        { cache: "no-store" },
      )
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          const appearance = payload?.preferences?.appearance;
          if (cancelled || !appearance || !Object.keys(appearance).length) return;
          apply(appearance);
          writeCachedAppearance(appearance);
          window.dispatchEvent(
            new CustomEvent("reply-radar-appearance-changed", {
              detail: appearance,
            }),
          );
        })
        .catch(() => undefined);
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent).detail as Appearance | undefined;
      apply(detail ?? readCachedAppearance() ?? {});
    };
    window.addEventListener("reply-radar-appearance-changed", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("reply-radar-appearance-changed", onChange);
    };
  }, []);
  return null;
}
