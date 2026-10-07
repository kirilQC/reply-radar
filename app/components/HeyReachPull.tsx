// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useCallback, useEffect, useState } from "react";

type Pull = {
  status: string;
  continuing: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  conversationsInHeyReach: number;
  pulledIn: number;
  summary: string;
};
type State = { lastReconciledAt: string | null; lastWebhookAt: string | null; pull: Pull | null };

const when = (value: string | null) => {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
};

/**
 * A client's HeyReach sync times, and the button for a full re-pull (see app/api/admin/heyreach/full-pull).
 * Replaces two fields that used to be fixed text ("Registered · 10 event types", "Today, 09:42 AM").
 */
export default function HeyReachPull({ slug, disabled }: { slug: string; disabled: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!slug || disabled) return;
    const response = await fetch(`/api/admin/heyreach/full-pull?client=${encodeURIComponent(slug)}`, { cache: "no-store" }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    if (payload?.ok) setState({ lastReconciledAt: payload.lastReconciledAt, lastWebhookAt: payload.lastWebhookAt, pull: payload.pull });
  }, [slug, disabled]);

  useEffect(() => {
    setState(null);
    setConfirming(false);
    setError("");
    void load();
  }, [load]);

  const active = state?.pull && (state.pull.status === "queued" || state.pull.status === "running");
  // Polled only while a pull is queued or running, and only while the tab is visible.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const start = async () => {
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/admin/heyreach/full-pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: slug }),
      });
      const payload = await response.json().catch(() => ({}));
      if (payload?.pull !== undefined) setState({ lastReconciledAt: payload.lastReconciledAt, lastWebhookAt: payload.lastWebhookAt, pull: payload.pull });
      if (!response.ok && response.status !== 409) setError(String(payload?.error || `Could not start the pull (${response.status}).`));
      setConfirming(false);
    } finally {
      setSending(false);
    }
  };

  const pull = state?.pull;
  const statusLine = !pull
    ? ""
    : pull.status === "queued"
      ? pull.continuing ? "Continuing the pull…" : "Queued. Starts within a minute."
      : pull.status === "running"
        ? "Pulling from HeyReach…"
        : `${pull.status === "failed" || pull.status === "error" ? "Failed" : pull.status === "partial" ? "Part done" : "Done"} ${when(pull.finishedAt)}${pull.summary ? `: ${pull.summary}` : ""}`;

  return (
    <div className="heyreach-pull">
      <div className="field-row">
        <label className="field-label">
          LAST WEBHOOK
          <div className="status-field">{disabled ? "Not configured" : when(state?.lastWebhookAt ?? null)}</div>
        </label>
        <label className="field-label">
          LAST RECONCILIATION
          <div className="status-field">{disabled ? "Not configured" : when(state?.lastReconciledAt ?? null)}</div>
        </label>
      </div>
      {!disabled && (
        <div className="heyreach-pull-action">
          {confirming ? (
            <div className="heyreach-pull-confirm" role="alertdialog" aria-label="Confirm full HeyReach pull">
              <p>Clears this client&apos;s stored HeyReach stats and pulls everything again with the saved key. Conversations that are not in this HeyReach account are removed.</p>
              <div>
                <button type="button" className="heyreach-pull-go" onClick={() => void start()} disabled={sending}>{sending ? "Starting…" : "Pull everything"}</button>
                <button type="button" onClick={() => setConfirming(false)} disabled={sending}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="heyreach-pull-button" onClick={() => setConfirming(true)} disabled={Boolean(active)}>
              {active ? "Pull in progress" : "Full HeyReach pull"}
            </button>
          )}
          {statusLine && <small className="heyreach-pull-status">{statusLine}</small>}
          {error && <small className="heyreach-pull-error">{error}</small>}
        </div>
      )}
    </div>
  );
}
