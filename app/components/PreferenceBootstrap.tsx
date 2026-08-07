"use client";

import { useEffect } from "react";

export default function PreferenceBootstrap() {
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("reply-radar-prefs:general");
      const appearance = raw ? JSON.parse(raw).appearance : null;
      if (!appearance) return;
      const root = document.documentElement;
      root.style.setProperty("--accent", appearance.accent || "#8b7cff");
      root.style.setProperty("--bg", appearance.background || "#0b0c10");
      root.style.setProperty(
        "--font",
        appearance.font || "Inter, ui-sans-serif, system-ui, sans-serif",
      );
      root.style.setProperty("--reply-radar-zoom", `${(appearance.zoom || 100) / 100}`);
      root.dataset.appearanceMode = appearance.mode || "midnight";
      document.body.classList.toggle("light-mode", appearance.mode === "light");
    } catch {
      // Defaults from the stylesheet remain active.
    }
  }, []);
  return null;
}
