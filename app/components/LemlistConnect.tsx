// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useCallback, useEffect, useState } from "react";

type Status = { connected: boolean; teamName: string | null; keyMasked: string; webhooks: number; syncedAt: string | null };

const when = (value: string | null) => {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
};

/**
 * A client's lemlist connection (app/api/lemlist/status): paste the client's lemlist API key and Connect, and
 * QC checks it, registers its reply webhooks in that lemlist team and pulls the last 14 days of replies.
 */
export default function LemlistConnect({ slug, disabled }: { slug: string; disabled: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!slug || disabled) return;
    const response = await fetch(`/api/lemlist/status?client=${encodeURIComponent(slug)}`, { cache: "no-store" }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    if (payload?.ok) setStatus(payload);
  }, [slug, disabled]);

  useEffect(() => {
    setStatus(null); setApiKey(""); setNote(""); setError("");
    void load();
  }, [load]);

  const run = async (action: "connect" | "sync" | "disconnect") => {
    setBusy(action); setNote(""); setError("");
    try {
      const response = await fetch("/api/lemlist/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, client: slug, apiKey: action === "connect" ? apiKey.trim() : undefined, days: action === "sync" ? 14 : undefined }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) { setError(String(payload?.error || `lemlist step failed (${response.status}).`)); return; }
      if ("connected" in payload) setStatus({ connected: payload.connected, teamName: payload.teamName, keyMasked: payload.keyMasked, webhooks: payload.webhooks, syncedAt: payload.syncedAt });
      const sync = action === "connect" ? payload.sync : payload;
      if (action === "connect") setApiKey("");
      if (action === "disconnect") setNote("Disconnected.");
      else if (sync) {
        const skipped = Object.entries((sync.skipped ?? {}) as Record<string, number>).map(([reason, count]) => `${count} ${reason.replace(/_/g, " ")}`).join(", ");
        const ingested = Array.isArray(sync.ingested) ? sync.ingested.length : Number(sync.ingested) || 0;
        setNote(`${ingested} conversation${ingested === 1 ? "" : "s"} pulled in from ${sync.checked ?? 0} replies${skipped ? ` · skipped: ${skipped}` : ""}`);
      }
    } finally {
      setBusy("");
    }
  };

  if (disabled) return null;
  return (
    <div className="heyreach-pull">
      <label className="field-label">
        LEMLIST API KEY
        <div className="secret-field">
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={status?.connected ? `Connected to ${status.teamName || "lemlist"} (${status.keyMasked}) · paste a new key to replace` : "Paste the client's lemlist API key"}
            type="password"
            autoComplete="off"
          />
          <button type="button" onClick={() => void run("connect")} disabled={Boolean(busy) || (!apiKey.trim() && !status?.connected)}>
            {busy === "connect" ? "Connecting…" : status?.connected && !apiKey.trim() ? "Reconnect" : "Connect"}
          </button>
        </div>
      </label>
      {status?.connected && (
        <div className="heyreach-pull-action">
          <small className="heyreach-pull-status">{status.teamName} · {status.webhooks} reply webhook{status.webhooks === 1 ? "" : "s"} · last sync {when(status.syncedAt)}</small>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="heyreach-pull-button" onClick={() => void run("sync")} disabled={Boolean(busy)}>{busy === "sync" ? "Syncing…" : "Sync last 14 days"}</button>
            <button type="button" className="heyreach-pull-button" onClick={() => void run("disconnect")} disabled={Boolean(busy)}>{busy === "disconnect" ? "Disconnecting…" : "Disconnect"}</button>
          </div>
        </div>
      )}
      {note && <small className="heyreach-pull-status">{note}</small>}
      {error && <small className="heyreach-pull-error">{error}</small>}
    </div>
  );
}
