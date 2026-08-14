// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useState } from "react";

/**
 * Paste the weekly sync call in, and let it fill the boxes.
 *
 * ── Why this exists next to "Talk it through" ────────────────────────────────────────────────────
 * Dictating a brief means saying the week out loud a second time, an hour after saying it to the
 * client on the call. The call already contains all of it — what shipped, what was promised, which
 * deals moved — and every meeting tool in use here already produces a transcript of it. So the
 * shorter path is to paste that transcript and have the sections read out of it.
 *
 * ── Why it is a separate control rather than the same box ────────────────────────────────────────
 * Two very different inputs. A dictated brief is one person, every word of it intended for the
 * report. A call is two or more people, an hour long, mostly small talk and tangents, and half of it
 * spoken by the client — which means the model has to be told to watch who is speaking, or a client's
 * request becomes our commitment. The route takes `source: "call"` and reads it under different
 * instructions; sharing this component with the dictation one would mean sharing the wrong prompt.
 *
 * ── Why nothing is written until it is reviewed ──────────────────────────────────────────────────
 * Same reason as the dictation control: this fills boxes that print verbatim in a client-facing
 * document. The filled sections land in the form above, still editable, and are read before the
 * report is generated. Nothing is sent anywhere from here.
 */

type Section = { id: string; label: string; placeholder: string };

/** Enough of a transcript to be one, rather than a sentence pasted by accident. */
const MIN_WORDS = 40;

export default function CallTranscript({
  sections,
  client,
  periodLabel,
  onFill,
}: {
  sections: Section[];
  client: string;
  periodLabel: string;
  onFill: (values: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ filled: number; truncated: boolean } | null>(null);

  if (!sections.length) return null;

  const words = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  const enough = words >= MIN_WORDS;

  const fill = async () => {
    if (!enough || filling) return;
    setFilling(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/reports/dictate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: transcript.trim(), client, periodLabel, sections, source: "call" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        setError(payload.error || "The sections could not be written.");
        return;
      }
      const values = (payload.values ?? {}) as Record<string, string>;
      onFill(values);
      setResult({ filled: Object.keys(values).length, truncated: Boolean(payload.truncated) });
    } catch {
      setError("The sections could not be written.");
    } finally {
      setFilling(false);
    }
  };

  return (
    <div className={`call-transcript ${open ? "is-open" : ""}`}>
      <div className="call-transcript-head">
        <div>
          <strong>Fill from a call transcript</strong>
          <em>
            Paste the weekly sync. It fills the {sections.length} section{sections.length === 1 ? "" : "s"} below —
            you review before anything is written.
          </em>
        </div>
        <button type="button" className="call-transcript-toggle" onClick={() => setOpen((current) => !current)}>
          {open ? "Close" : "Paste transcript"}
        </button>
      </div>

      {open && (
        <>
          <textarea
            className="call-transcript-box"
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            placeholder="Paste the whole transcript, speaker labels and all. Timestamps are fine — they are ignored."
          />
          <div className="call-transcript-actions">
            <button type="button" className="call-transcript-fill" onClick={() => void fill()} disabled={!enough || filling}>
              {filling ? "Reading the call…" : "Fill the sections"}
            </button>
            <button
              type="button"
              className="call-transcript-clear"
              onClick={() => {
                setTranscript("");
                setResult(null);
                setError("");
              }}
              disabled={filling}
            >
              Clear
            </button>
            <span>
              {words
                ? enough
                  ? `${words.toLocaleString()} words`
                  : `${words} words — paste more of the call`
                : "Speaker labels help it tell your side from theirs."}
            </span>
          </div>
        </>
      )}

      {result && (
        <p className="call-transcript-done">
          {result.filled
            ? `Filled ${result.filled} of ${sections.length} section${sections.length === 1 ? "" : "s"}. Anything the call did not cover was left blank.`
            : "Nothing on the call matched these sections, so nothing was changed."}
          {result.truncated && " The transcript was long, so only the later part of the call was read."}
        </p>
      )}
      {error && <p className="call-transcript-error">{error}</p>}
    </div>
  );
}
