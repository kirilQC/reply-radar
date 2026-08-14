// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { usePopoverDismiss } from "../lib/use-popover-dismiss";

export type AppearancePrefs = {
  mode: "midnight" | "light";
  zoom: number;
  font: string;
  background: string;
  accent: string;
  timeZone: string;
};

export default function AppearancePanel({
  prefs,
  onChange,
  onSave,
}: {
  prefs: AppearancePrefs;
  onChange: (prefs: AppearancePrefs) => void;
  onSave: () => void;
}) {
  // Clicking away from a settings panel is how people mean to commit it, so dismissal and
  // save are the same action here.
  const ref = usePopoverDismiss<HTMLDivElement>(onSave);
  return (
    <div className="customize-popover appearance-popover" ref={ref}>
      <div className="customize-popover-heading">
        <div><strong>Appearance</strong><small>Saved to this profile and device.</small></div>
        <span>◐</span>
      </div>
      <label className="customize-field">MODE<select value={prefs.mode} onChange={(event) => onChange({ ...prefs, mode: event.target.value as AppearancePrefs["mode"] })}><option value="midnight">Dark</option><option value="light">Light</option></select></label>
      <label className="customize-field">ZOOM <b>{prefs.zoom}%</b><input type="range" min="85" max="120" step="5" value={prefs.zoom} onChange={(event) => onChange({ ...prefs, zoom: Number(event.target.value) })} /></label>
      <label className="customize-field">FONT<select value={prefs.font} onChange={(event) => onChange({ ...prefs, font: event.target.value })}><option value="Inter, ui-sans-serif, system-ui, sans-serif">Inter / System</option><option value="Georgia, serif">Georgia</option><option value="ui-monospace, SFMono-Regular, Menlo, monospace">Mono</option><option value="Arial, sans-serif">Arial</option></select></label>
      <label className="customize-field">DASHBOARD TIME ZONE<select value={prefs.timeZone} onChange={(event) => onChange({ ...prefs, timeZone: event.target.value })}><option value="America/New_York">Eastern Time — New York</option><option value="America/Chicago">Central Time — Chicago</option><option value="America/Denver">Mountain Time — Denver</option><option value="America/Los_Angeles">Pacific Time — Los Angeles</option><option value="Pacific/Honolulu">Hawaii Time — Honolulu</option><option value="UTC">UTC</option><option value="Europe/London">London</option><option value="Europe/Berlin">Central Europe</option><option value="Asia/Kolkata">India</option><option value="Asia/Singapore">Singapore</option><option value="Australia/Sydney">Sydney</option></select><small>Used for Inbox reply dates and conversation timestamps.</small></label>
      <div className="customize-color-row"><label className="customize-field">BACKGROUND<input type="color" value={prefs.background} onChange={(event) => onChange({ ...prefs, background: event.target.value })} /></label><label className="customize-field">ACCENT<input type="color" value={prefs.accent} onChange={(event) => onChange({ ...prefs, accent: event.target.value })} /></label></div>
      <button className="customize-save" onClick={onSave}>Save appearance</button>
    </div>
  );
}
