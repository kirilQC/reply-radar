"use client";

import { useEffect, useState } from "react";
import AppearancePanel, { type AppearancePrefs } from "./AppearancePanel";

const defaults: AppearancePrefs = {
  mode: "midnight",
  zoom: 100,
  font: "Inter, ui-sans-serif, system-ui, sans-serif",
  background: "#0b0c10",
  accent: "#8b7cff",
  accent2: "",
  timeZone: "America/New_York",
};

const applyAppearance = (appearance: AppearancePrefs) => {
  const root = document.documentElement;
  root.style.setProperty("--accent", appearance.accent);
  root.style.setProperty("--bg", appearance.background);
  root.style.setProperty("--font", appearance.font);
  root.style.setProperty("--reply-radar-zoom", String(appearance.zoom / 100));
  root.dataset.appearanceMode = appearance.mode;
  document.body.classList.toggle("light-mode", appearance.mode === "light");
};

export default function GlobalAppearanceControl() {
  const [appearance, setAppearance] = useState<AppearancePrefs>(() => {
    if (typeof window === "undefined") return defaults;
    try {
      const stored = JSON.parse(window.localStorage.getItem("reply-radar-prefs:general") || "{}");
      return stored.appearance ? { ...defaults, ...stored.appearance } : defaults;
    } catch { return defaults; }
  });
  const [open, setOpen] = useState(false);

  useEffect(() => { applyAppearance(appearance); }, [appearance]);

  const save = () => {
    let stored: Record<string, unknown> = {};
    try { stored = JSON.parse(window.localStorage.getItem("reply-radar-prefs:general") || "{}"); } catch { /* replace invalid cache */ }
    window.localStorage.setItem("reply-radar-prefs:general", JSON.stringify({ ...stored, appearance }));
    window.dispatchEvent(new CustomEvent("reply-radar-appearance-changed", { detail: appearance }));
    setOpen(false);
  };

  return (
    <>
      <button className="icon-button theme-toggle" aria-label="Customize appearance" title="Customize appearance" onClick={() => setOpen((value) => !value)}>◐</button>
      {open && <AppearancePanel prefs={appearance} onChange={setAppearance} onSave={save} />}
    </>
  );
}
