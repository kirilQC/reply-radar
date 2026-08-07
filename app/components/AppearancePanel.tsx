"use client";

export type AppearancePrefs = {
  mode: "midnight" | "light";
  zoom: number;
  font: string;
  background: string;
  accent: string;
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
  return (
    <div className="customize-popover appearance-popover">
      <div className="customize-popover-heading">
        <div><strong>Appearance</strong><small>Saved to this profile and device.</small></div>
        <span>◐</span>
      </div>
      <label className="customize-field">MODE<select value={prefs.mode} onChange={(event) => onChange({ ...prefs, mode: event.target.value as AppearancePrefs["mode"] })}><option value="midnight">Dark</option><option value="light">Light</option></select></label>
      <label className="customize-field">ZOOM <b>{prefs.zoom}%</b><input type="range" min="85" max="120" step="5" value={prefs.zoom} onChange={(event) => onChange({ ...prefs, zoom: Number(event.target.value) })} /></label>
      <label className="customize-field">FONT<select value={prefs.font} onChange={(event) => onChange({ ...prefs, font: event.target.value })}><option value="Inter, ui-sans-serif, system-ui, sans-serif">Inter / System</option><option value="Georgia, serif">Georgia</option><option value="ui-monospace, SFMono-Regular, Menlo, monospace">Mono</option><option value="Arial, sans-serif">Arial</option></select></label>
      <div className="customize-color-row"><label className="customize-field">BACKGROUND<input type="color" value={prefs.background} onChange={(event) => onChange({ ...prefs, background: event.target.value })} /></label><label className="customize-field">ACCENT<input type="color" value={prefs.accent} onChange={(event) => onChange({ ...prefs, accent: event.target.value })} /></label></div>
      <button className="customize-save" onClick={onSave}>Save appearance</button>
    </div>
  );
}
