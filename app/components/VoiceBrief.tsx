// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Speak a week's context instead of typing it into five boxes.
 *
 * Transcription runs in the browser's own speech recogniser rather than through an API. That is
 * deliberate: it needs no key and no upload, the words appear as they are said so you can tell it is
 * working, and no audio of a client conversation ever leaves the machine. The cost is that it only
 * exists in Chrome, Edge and Safari — so the control hides itself entirely where it would not work,
 * rather than offering a button that fails when pressed.
 *
 * Nothing is written to the form until the transcript has been read back and accepted. A recogniser
 * that mishears a company name is a normal Tuesday, and the review step is where that gets caught,
 * before it reaches a client-facing report.
 */

type Section = { id: string; label: string; placeholder: string };

/** The bits of the Web Speech API this uses. It has no TypeScript definitions in the DOM lib. */
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechEvent = { resultIndex: number; results: { length: number } & Record<number, SpeechResult> };
type Recogniser = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type RecogniserWindow = Window & {
  SpeechRecognition?: new () => Recogniser;
  webkitSpeechRecognition?: new () => Recogniser;
};

const recogniserClass = () => {
  if (typeof window === "undefined") return null;
  const scope = window as RecogniserWindow;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
};

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export default function VoiceBrief({
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
  const [listening, setListening] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState("");
  const [filledCount, setFilledCount] = useState<number | null>(null);
  const recogniser = useRef<Recogniser | null>(null);
  // Whether the last stop was ours. The recogniser also ends itself on a long silence, and that
  // should not look like the user pressing stop.
  const stopping = useRef(false);

  /**
   * Whether this browser can transcribe at all.
   *
   * Read through an external store rather than an effect so the server renders "no" and the client
   * renders the truth on its first pass — a control that appears a beat after the panel does looks
   * like a bug, and a control assumed present on the server would mismatch on hydration.
   */
  const supported = useSyncExternalStore(
    () => () => {},
    () => Boolean(recogniserClass()),
    () => false,
  );

  useEffect(() => {
    if (!listening) return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [listening]);

  const stop = useCallback(() => {
    stopping.current = true;
    recogniser.current?.stop();
    recogniser.current = null;
    setListening(false);
    setInterim("");
  }, []);

  useEffect(() => () => recogniser.current?.stop(), []);

  const start = () => {
    const Recogniser = recogniserClass();
    if (!Recogniser) return;
    setError("");
    setFilledCount(null);
    setSeconds(0);
    const instance = new Recogniser();
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = "en-US";
    instance.onresult = (event) => {
      let settled = "";
      let pending = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) settled += `${result[0].transcript} `;
        else pending += result[0].transcript;
      }
      if (settled) setTranscript((current) => `${current}${settled}`);
      setInterim(pending);
    };
    instance.onerror = (event) => {
      setError(
        event.error === "not-allowed"
          ? "Microphone access was blocked. Allow it in the browser's site settings and try again."
          : event.error === "no-speech"
            ? "Nothing was heard. Check the right microphone is selected."
            : `The recogniser stopped: ${event.error}.`,
      );
      stopping.current = true;
      setListening(false);
    };
    // A pause in speech ends the session in some browsers, so it restarts itself until stopped.
    instance.onend = () => {
      if (stopping.current) return;
      try {
        instance.start();
      } catch {
        setListening(false);
      }
    };
    stopping.current = false;
    recogniser.current = instance;
    try {
      instance.start();
      setListening(true);
    } catch {
      setError("The microphone could not be started.");
    }
  };

  const fill = async () => {
    const spoken = transcript.trim();
    if (!spoken || filling) return;
    setFilling(true);
    setError("");
    try {
      const response = await fetch("/api/reports/dictate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: spoken, client, periodLabel, sections }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        setError(payload.error || "The sections could not be written.");
        return;
      }
      const values = (payload.values ?? {}) as Record<string, string>;
      onFill(values);
      setFilledCount(Object.keys(values).length);
    } catch {
      setError("The sections could not be written.");
    } finally {
      setFilling(false);
    }
  };

  if (!supported || !sections.length) return null;

  const words = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;

  return (
    <div className={`voice-brief ${listening ? "is-listening" : ""}`}>
      <div className="voice-brief-head">
        <div>
          <strong>Talk it through</strong>
          <em>
            Speak for a minute about the week. It fills the {sections.length} section
            {sections.length === 1 ? "" : "s"} below — you review before anything is written.
          </em>
        </div>
        {listening ? (
          <button type="button" className="voice-brief-stop" onClick={stop}>
            <i aria-hidden="true" /> Stop · {clock(seconds)}
          </button>
        ) : (
          <button type="button" className="voice-brief-start" onClick={start}>
            {transcript ? "Record more" : "Start talking"}
          </button>
        )}
      </div>

      {(listening || transcript) && (
        <>
          <label className="voice-brief-label" htmlFor="voice-transcript">
            {listening ? "Listening…" : `Transcript · ${words} word${words === 1 ? "" : "s"}`}
          </label>
          <textarea
            id="voice-transcript"
            className="voice-brief-transcript"
            value={listening && interim ? `${transcript}${interim}` : transcript}
            readOnly={listening}
            placeholder="What you say appears here."
            onChange={(event) => setTranscript(event.target.value)}
          />
        </>
      )}

      {!listening && transcript.trim() && (
        <div className="voice-brief-actions">
          <button type="button" className="voice-brief-fill" onClick={() => void fill()} disabled={filling}>
            {filling ? "Writing the sections…" : "Fill the sections"}
          </button>
          <button
            type="button"
            className="voice-brief-clear"
            onClick={() => {
              setTranscript("");
              setFilledCount(null);
              setError("");
            }}
            disabled={filling}
          >
            Discard
          </button>
          <span>Edit the transcript first if anything was misheard.</span>
        </div>
      )}

      {filledCount !== null && (
        <p className="voice-brief-done">
          {filledCount
            ? `Filled ${filledCount} of ${sections.length} section${sections.length === 1 ? "" : "s"}. Anything you did not mention was left blank.`
            : "Nothing in the transcript matched these sections, so nothing was changed."}
        </p>
      )}
      {error && <p className="voice-brief-error">{error}</p>}
    </div>
  );
}
