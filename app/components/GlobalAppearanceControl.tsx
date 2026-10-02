// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import AppearancePanel, { type AppearancePrefs } from "./AppearancePanel";
import {
  identityKey,
  readCachedAppearance,
  writeCachedAppearance,
} from "../lib/preference-identity";
import { accentOf, applyAccent, DEFAULT_ACCENT } from "../lib/brand-theme";

const defaults: AppearancePrefs = {
  mode: "midnight",
  zoom: 100,
  font: "Inter, ui-sans-serif, system-ui, sans-serif",
  background: "#0b0c10",
  accent: DEFAULT_ACCENT,
  timeZone: "America/New_York",
};

const applyAppearance = (appearance: AppearancePrefs) => {
  const root = document.documentElement;
  applyAccent(appearance.accent);
  root.style.setProperty("--bg", appearance.background);
  root.style.setProperty("--font", appearance.font);
  root.style.setProperty("--reply-radar-zoom", String(appearance.zoom / 100));
  root.dataset.appearanceMode = appearance.mode;
  document.body.classList.toggle("light-mode", appearance.mode === "light");
};

export default function GlobalAppearanceControl() {
  // Defaults first, as the server rendered them; the cached look is applied before paint (see below), so the
  // browser's first render matches the server's and React does not discard the page (hydration error #418).
  const [appearance, setAppearance] = useState<AppearancePrefs>(defaults);
  useLayoutEffect(() => {
    const stored = readCachedAppearance();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setAppearance({ ...defaults, ...stored, accent: accentOf(stored) });
  }, []);
  const [open, setOpen] = useState(false);

  useEffect(() => { applyAppearance(appearance); }, [appearance]);
  // PreferenceBootstrap can restore a look off the server after this mounted; follow it so the
  // panel shows what is actually on screen.
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | Partial<AppearancePrefs>
        | undefined;
      if (detail) setAppearance((current) => ({ ...current, ...detail, accent: accentOf({ ...current, ...detail }) }));
    };
    window.addEventListener("reply-radar-appearance-changed", onChange);
    return () =>
      window.removeEventListener("reply-radar-appearance-changed", onChange);
  }, []);

  const save = () => {
    writeCachedAppearance(appearance);
    // Local storage alone meant a new browser — or the same person on another machine — got
    // the stock purple back. Appearance is stored against the identity, with no scope, so it
    // is the same everywhere on the site.
    void fetch("/api/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identity: identityKey(),
        scope: identityKey(),
        preferences: { appearance },
      }),
    }).catch(() => undefined);
    window.dispatchEvent(new CustomEvent("reply-radar-appearance-changed", { detail: appearance }));
    setOpen(false);
  };

  return (
    <>
      <button className="icon-button theme-toggle" data-popover-toggle aria-label="Customize appearance" title="Customize appearance" onClick={() => setOpen((value) => !value)}>◐</button>
      {open && <AppearancePanel prefs={appearance} onChange={setAppearance} onSave={save} />}
    </>
  );
}
