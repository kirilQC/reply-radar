// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useRef } from "react";

/**
 * Closes a popover when the pointer goes down outside it, or on Escape.
 *
 * Clicking away is how people expect to commit a small settings panel, so callers pass the
 * same handler they give the panel's Save button rather than a separate "cancel".
 *
 * The button that opened the popover is excluded: it toggles on click, so dismissing on the
 * way down would close and immediately reopen. Marking those buttons
 * `data-popover-toggle` keeps the exclusion out here, where the popover cannot see them.
 *
 * Returns a ref for the popover's own root. While it is null — which is what happens when
 * the popover is not rendered — the listeners do nothing, so the hook can be called
 * unconditionally from a component that only sometimes shows the panel.
 */
export function usePopoverDismiss<T extends HTMLElement>(onDismiss: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const root = ref.current;
      const target = event.target as HTMLElement | null;
      if (!root || !target || root.contains(target)) return;
      if (target.closest?.("[data-popover-toggle]")) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current) onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);
  return ref;
}
