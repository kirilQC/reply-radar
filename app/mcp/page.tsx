"use client";

/**
 * The MCP tab: one chat box over everything Reply Radar and HeyReach know.
 *
 * ── What the browser is and is not ──────────────────────────────────────────────────────────────
 * A dumb terminal, deliberately. It holds the visible transcript and posts it back on each turn;
 * every decision, every tool call and every API key stays on the server. Nothing here can reach
 * HeyReach or Supabase, which is why none of their credentials need to exist in this file.
 *
 * ── Why the working is shown while it happens ───────────────────────────────────────────────────
 * These answers can take a minute or more, because the assistant is told to be thorough rather than
 * fast — a question about every campaign is a tool call per client and then some. A spinner for that
 * long reads as broken, and worse, it hides the part worth watching: which client it is on, which
 * tool it just ran, what it is reasoning about. So the route streams its thinking and every tool call
 * as they happen and they are rendered as a live timeline.
 *
 * The timeline is kept after the answer lands, collapsed. An assistant that says "Steadywell got 47
 * replies" is indistinguishable from one that guessed, and the first wrong number destroys trust in
 * every right one — so every answer keeps the receipts for the number in it.
 *
 * ── Why exports are asked for rather than always offered ────────────────────────────────────────
 * The output of "rank these campaigns" or "who needs following up" is often on its way into a sheet
 * or a client email — but most answers are not, and a row of Copy/CSV/PDF buttons under every one of
 * them was three pieces of permanent furniture serving an occasional need. So the assistant offers
 * the download instead, by ending an answer with an `export` fence when it was asked to, and the
 * buttons appear on that answer only. CSV lifts the tables out of the answer; PDF is the browser's
 * own print path, which is how the Reports tab already does it.
 *
 * A HeyReach lead list does not work that way and must not: `heyreach_export_list` builds the file on
 * the server and streams it here as its own event, so the rows never pass through the model. Those
 * arrive as a download attached to the answer rather than as a button that regenerates it.
 *
 * ── Attachments ─────────────────────────────────────────────────────────────────────────────────
 * Questions frequently start with something the person already has: a client's spreadsheet, a PDF
 * brief, a screenshot of a HeyReach screen that does not match what we are reporting. Those go up as
 * base64 and Anthropic reads them natively, which is far better than anything we could extract here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import Markdown from "../components/Markdown";
import { answerToCsv, exportFilename } from "../../shared/answer-export.mjs";
// The same wire format the route reads from Anthropic, so the same two helpers parse it.
import { parseFrame, splitFrames } from "../../shared/anthropic-stream.mjs";

/** One thing the assistant did, in the order it did it. */
type Entry =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: string; input: Record<string, unknown>; ok: boolean | null; detail: string };
/** Something the person attached, already base64 so it can be posted as JSON. */
type Attached = { name: string; mime: string; data: string };
/** Something a tool built and sent down, ready to save. */
type Delivered = { name: string; mime: string; content: string };
type Message = {
  role: "user" | "assistant";
  content: string;
  entries?: Entry[];
  attached?: Attached[];
  files?: Delivered[];
  failed?: boolean;
  askedAt?: string;
};

/**
 * Roughly three megabytes of actual file, since base64 costs a third.
 *
 * The real limit is the platform's request body, and the whole conversation is re-posted on every
 * turn — so this is a budget for the question, not for one file.
 */
const MAX_ATTACHED = 4_000_000;
const ACCEPTS = "image/png,image/jpeg,image/gif,image/webp,application/pdf,.csv,.tsv,.txt,.md,.json";

/** A file as base64, without the data-URL prefix the API does not want. */
const asBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });

/** Saves a blob under a name. The one way anything leaves this page. */
function save(name: string, mime: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** `48213` → `47 KB`. Files are sized in the chip because "leads.csv" alone says nothing about it. */
const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${Math.round(bytes)} B` : bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;

/**
 * Openers, chosen to teach the surface rather than to demo it.
 *
 * Each one exercises a different part — live HeyReach status, our stored replies, a search of the
 * database by title, a file export, a cross-client comparison — because the question people cannot
 * guess is what this thing can be asked, and five examples answer that faster than any description.
 */
const PROMPTS = [
  "What campaigns are live for Steadywell right now, and when do they run out of leads?",
  "Who replied and hasn't been followed up with yet? Oldest first.",
  "List every CISO in our database and say which ones have replied.",
  "Export Steadywell's biggest lead list as a CSV.",
  "Compare every client's reply performance and tell me who needs attention.",
];

/** A tool name as a person would say it: `heyreach_campaign_metrics` → "HeyReach campaign metrics". */
const toolLabel = (name: string) =>
  name.replace(/^heyreach_/, "HeyReach ").replace(/_/g, " ").replace(/^(\w)/, (letter) => letter.toUpperCase());

/** The arguments a tool was called with, short enough to sit on one line. */
const toolArgs = (input: Record<string, unknown>) =>
  Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== "" && value !== null)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join(" · ");

/** `83` → `1m 23s`. Elapsed time is the only honest reassurance during a long lookup. */
const elapsed = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;

/**
 * The live timeline, and the collapsed record of it afterwards.
 *
 * Thinking is clamped to a few lines while it streams so a long deliberation cannot push the answer
 * off the screen; the full text is there once it is opened.
 */
function Timeline({ entries, live }: { entries: Entry[]; live: boolean }) {
  return (
    <ol className={`mcp-timeline ${live ? "is-live" : ""}`}>
      {entries.map((entry, index) => {
        if (entry.kind === "thinking") {
          return (
            <li className="mcp-thought" key={index}>
              <span className="mcp-thought-mark" aria-hidden="true" />
              <p>{entry.text}</p>
            </li>
          );
        }
        const state = entry.ok === null ? "running" : entry.ok ? "done" : "failed";
        return (
          <li className={`mcp-lookup is-${state}`} key={index}>
            <span className="mcp-lookup-mark" aria-hidden="true" />
            <div>
              <b>{toolLabel(entry.tool)}</b>
              {toolArgs(entry.input) && <span>{toolArgs(entry.input)}</span>}
              {entry.ok === false && <i>{entry.detail}</i>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default function McpPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [thinking, setThinking] = useState(false);
  /** The turn in progress: what it has done so far and what it has started writing. */
  const [live, setLive] = useState<{ entries: Entry[]; answer: string }>({ entries: [], answer: "" });
  /**
   * Elapsed time is derived from a start stamp rather than counted up in state, so the ticking
   * interval never has to reset anything from inside an effect.
   */
  const [now, setNow] = useState(0);
  const startedAt = useRef(0);
  const [openTrail, setOpenTrail] = useState<number | null>(null);
  const [printing, setPrinting] = useState<number | null>(null);
  const [attached, setAttached] = useState<Attached[]>([]);
  const [attachNote, setAttachNote] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Scrolling, split in two because the two cases want opposite behaviour.
   *
   * A finished turn is a jump the reader did not ask for, so it is animated. The streaming tail is
   * not a jump at all — it is a line growing — and animating it was the single worst part of watching
   * an answer arrive: every token restarted a smooth scroll that had not finished the last one, so
   * the page hunted instead of following. Instant, once per painted frame, is what reads as smooth.
   *
   * Neither one drags the page back if the reader has scrolled up to re-read something.
   */
  const nearBottom = () =>
    window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!thinking || !nearBottom()) return;
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [live, thinking]);

  useEffect(() => {
    if (!thinking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [thinking]);
  const seconds = Math.max(0, Math.floor((now - startedAt.current) / 1000));

  /**
   * Takes files onto the next question.
   *
   * Refused rather than truncated when the budget runs out, and said out loud: a file silently
   * dropped would be a question answered from less than the person handed over, which is worse than
   * a question that does not send.
   */
  const attach = async (picked: FileList | null) => {
    if (!picked?.length) return;
    const read = await Promise.all(
      Array.from(picked).map(async (file) => ({
        name: file.name,
        // Some browsers report nothing for a .csv dragged out of a mail client.
        mime: file.type || "text/plain",
        data: await asBase64(file),
      })),
    );
    const next = [...attached];
    let refused = "";
    for (const file of read) {
      if (!file.data || next.some((held) => held.name === file.name)) continue;
      const total = next.reduce((sum, held) => sum + held.data.length, 0) + file.data.length;
      if (total > MAX_ATTACHED) refused = `${file.name} does not fit. About 3 MB of files can ride along with one question.`;
      else next.push(file);
    }
    setAttached(next);
    setAttachNote(refused);
  };

  const send = async (raw: string) => {
    const asked = raw.trim();
    if ((!asked && !attached.length) || thinking) return;
    // The history posted to the server is the one on screen plus this question. Built here rather
    // than read back from state because a state update is not visible to the request that follows it.
    const history = [
      ...messages,
      { role: "user" as const, content: asked, attached, askedAt: new Date().toISOString() },
    ];
    setMessages(history);
    setQuestion("");
    setAttached([]);
    setAttachNote("");
    setThinking(true);
    setLive({ entries: [], answer: "" });
    startedAt.current = Date.now();
    setNow(Date.now());

    /**
     * The turn is accumulated in a local, not in state.
     *
     * Deltas arrive faster than React commits, and `setLive(previous => …)` on every token would both
     * batch unpredictably and make the final `setMessages` depend on state it cannot see yet. State is
     * written from these on each event purely to redraw.
     */
    const entries: Entry[] = [];
    /** Files tools built during the turn. They belong to the answer, so they land with it. */
    const produced: Delivered[] = [];
    let answer = "";
    /** Consecutive thinking deltas belong to one thought; a tool call ends it. */
    let openThought: { kind: "thinking"; text: string } | null = null;

    /**
     * Redraw at most once a frame.
     *
     * Deltas arrive in bursts — several within a millisecond, then a pause — and setting state on
     * every one meant a commit the screen had no chance to show. Coalescing into the next animation
     * frame caps the redraws at the refresh rate, which costs nothing in latency because a frame is
     * the fastest anything can become visible anyway.
     *
     * This is the smaller half of the smoothness fix. Parsing a whole answer measures around 80ms
     * spread across its entire arrival, so the parser was never the problem; the cost was in what
     * each commit dragged along with it — every row of a growing table re-diffed on every frame — and
     * that is what the split in `Markdown` addresses.
     */
    let frame = 0;
    const paint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setLive({ entries: [...entries], answer });
      });
    };

    try {
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content, attached: files }) => ({ role, content, files })),
        }),
      });
      if (!response.body) throw new Error("The assistant returned nothing.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      const finish = (message: Message) => {
        settled = true;
        setMessages([...history, message]);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = splitFrames(buffer) as { frames: string[]; rest: string };
        buffer = rest;
        for (const frame of frames) {
          const event = parseFrame(frame) as Record<string, unknown> | null;
          if (!event) continue;

          if (event.type === "thinking") {
            if (!openThought) {
              openThought = { kind: "thinking", text: "" };
              entries.push(openThought);
            }
            openThought.text += String(event.text ?? "");
            paint();
          } else if (event.type === "text") {
            answer += String(event.text ?? "");
            paint();
          } else if (event.type === "tool") {
            openThought = null;
            entries.push({
              kind: "tool",
              tool: String(event.tool ?? ""),
              input: (event.input ?? {}) as Record<string, unknown>,
              ok: null,
              detail: "",
            });
            paint();
          } else if (event.type === "tool_done") {
            // Matched to the newest unfinished call of that name: several tools run at once, and they
            // finish in whatever order the APIs behind them respond.
            const finished = String(event.tool ?? "");
            const pending = [...entries]
              .reverse()
              .find((entry) => entry.kind === "tool" && entry.ok === null && entry.tool === finished);
            if (pending && pending.kind === "tool") {
              pending.ok = event.ok === true;
              pending.detail = String(event.detail ?? "");
            }
            paint();
          } else if (event.type === "file") {
            // Built by a tool and streamed down whole, because the rows in it were deliberately kept
            // out of the model's context — this is the only copy, and it is the real one.
            produced.push({
              name: String(event.name ?? "export.csv"),
              mime: String(event.mime ?? "text/csv;charset=utf-8"),
              content: String(event.content ?? ""),
            });
          } else if (event.type === "done") {
            finish({
              role: "assistant",
              content: String(event.reply ?? ""),
              entries: [...entries],
              files: [...produced],
              askedAt: new Date().toISOString(),
            });
          } else if (event.type === "failed") {
            finish({
              role: "assistant",
              content: String(event.error ?? "The assistant could not finish."),
              entries: [...entries],
              files: [...produced],
              failed: true,
              askedAt: new Date().toISOString(),
            });
          }
        }
      }

      // The stream ended without a verdict — the platform cut it, or the tab slept. Whatever was
      // already written is kept, because a partial answer with its lookups visible is worth more than
      // an error that throws the work away.
      if (!settled) {
        finish({
          role: "assistant",
          content: answer || "The answer stopped part-way through. Ask again, or narrow the question.",
          entries: [...entries],
          files: [...produced],
          failed: !answer,
          askedAt: new Date().toISOString(),
        });
      }
    } catch {
      setMessages([
        ...history,
        {
          role: "assistant",
          content: "The request did not complete. Check your connection and ask again.",
          entries: [...entries],
          failed: true,
          askedAt: new Date().toISOString(),
        },
      ]);
    } finally {
      // Cancelled before the live turn is cleared, or a frame queued by the last delta would land
      // afterwards and put the half-written answer back underneath the finished one.
      if (frame) cancelAnimationFrame(frame);
      setThinking(false);
      setLive({ entries: [], answer: "" });
      inputRef.current?.focus();
    }
  };

  /** The question an answer belongs to, for the export header and the filename. */
  const questionFor = (index: number) => {
    for (let step = index - 1; step >= 0; step -= 1) if (messages[step].role === "user") return messages[step].content;
    return "";
  };

  /**
   * Exporting one answer, from the button its own `export` block drew.
   *
   * One callback for both formats, and memoised on the transcript rather than rebuilt per message,
   * because an arrow function created inside the render loop would change identity on every painted
   * frame and defeat the memo on `Markdown` — which is precisely what makes a long answer type
   * smoothly. It is stable for the whole of a streaming turn, since `messages` does not change until
   * the answer lands.
   *
   * PDF is the browser's print path: the page is hidden by print CSS except the turn marked
   * `is-printing`, so the file is the answer and its question rather than a screenshot of a chat app.
   * `printing` is cleared on the tick after `print()` returns, which is when the dialog has closed.
   */
  const exportAnswer = useCallback(
    (index: number, format: string) => {
      const message = messages[index];
      if (!message) return;
      if (format === "pdf") {
        setPrinting(index);
        window.setTimeout(() => {
          window.print();
          setPrinting(null);
        }, 60);
        return;
      }
      let asked = "";
      for (let step = index - 1; step >= 0; step -= 1) {
        if (messages[step].role === "user") {
          asked = messages[step].content;
          break;
        }
      }
      const csv = answerToCsv({ question: asked, answer: message.content, askedAt: message.askedAt ?? "" });
      save(exportFilename(asked, message.askedAt ?? "", "csv"), "text/csv;charset=utf-8", csv);
    },
    [messages],
  );

  const liveCount = useMemo(() => live.entries.filter((entry) => entry.kind === "tool").length, [live.entries]);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar print-hide">
          <Crumb trail={[{ label: "MCP" }]} />
          <div className="top-actions">
            {messages.length > 0 && !thinking && (
              <button className="mcp-reset" onClick={() => { setMessages([]); setOpenTrail(null); }}>
                New conversation
              </button>
            )}
            <GlobalAppearanceControl />
          </div>
        </header>

        <main className="mcp-page">
          {messages.length === 0 ? (
            <div className="mcp-intro">
              <h1>Ask anything</h1>
              <p>
                Live HeyReach campaigns, senders, sequences and lists for every client, plus everyone
                in Reply Radar&apos;s own database — searchable by job title or company — with their
                replies, scores and follow-ups. Attach a screenshot, PDF or spreadsheet and it will
                read that too, and ask for any answer as a CSV or a PDF. Read-only: nothing here can
                send, pause or change anything. Bigger questions take longer on purpose; you can watch
                the lookups as they run.
              </p>
              <div className="mcp-prompts">
                {PROMPTS.map((prompt) => (
                  <button key={prompt} className="mcp-prompt" onClick={() => void send(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mcp-thread">
              {messages.map((message, index) => (
                <article
                  className={`mcp-turn mcp-${message.role}${message.failed ? " mcp-failed" : ""}${printing === index ? " is-printing" : ""}`}
                  key={index}
                >
                  {/* The question rides along in the print output; on screen the bubble above already says it. */}
                  {message.role === "assistant" && <p className="mcp-print-question">{questionFor(index)}</p>}

                  {message.role === "assistant" && message.entries && message.entries.length > 0 && (
                    <div className="mcp-trail print-hide">
                      <button
                        className="mcp-trail-toggle"
                        onClick={() => setOpenTrail(openTrail === index ? null : index)}
                      >
                        {message.entries.filter((entry) => entry.kind === "tool").length} lookups
                        {message.entries.some((entry) => entry.kind === "tool" && entry.ok === false) && (
                          <em> · 1 or more failed</em>
                        )}
                        <span aria-hidden="true">{openTrail === index ? "▴" : "▾"}</span>
                      </button>
                      {openTrail === index && <Timeline entries={message.entries} live={false} />}
                    </div>
                  )}

                  {message.role === "assistant" ? (
                    <Markdown onExport={exportAnswer} exportKey={index}>
                      {message.content}
                    </Markdown>
                  ) : (
                    <div className="mcp-body">{message.content}</div>
                  )}

                  {/* What the person attached, and what a tool built. Both are files hanging off a
                      turn, so they look the same; only the direction differs. */}
                  {message.attached?.length ? (
                    <div className="mcp-files print-hide">
                      {message.attached.map((file) => (
                        <span className="mcp-file" key={file.name}>
                          <b>{file.name}</b>
                          <small>{sizeOf(file.data.length * 0.75)}</small>
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {message.files?.length ? (
                    <div className="mcp-files print-hide">
                      {message.files.map((file) => (
                        <button
                          className="mcp-file is-download"
                          key={file.name}
                          type="button"
                          onClick={() => save(file.name, file.mime, file.content)}
                        >
                          <b>{file.name}</b>
                          <small>{sizeOf(file.content.length)} · download</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}

              {thinking && (
                <article className="mcp-turn mcp-assistant mcp-working">
                  <div className="mcp-working-head">
                    <span className="mcp-dots" aria-hidden="true"><i /><i /><i /></span>
                    <span>
                      {liveCount === 0
                        ? "Working out where to look"
                        : `${liveCount} ${liveCount === 1 ? "lookup" : "lookups"} so far`}
                    </span>
                    <b>{elapsed(seconds)}</b>
                  </div>
                  <Timeline entries={live.entries} live />
                  {live.answer && <Markdown live>{live.answer}</Markdown>}
                </article>
              )}
              <div ref={endRef} />
            </div>
          )}

          <form
            className="mcp-composer print-hide"
            onSubmit={(event) => {
              event.preventDefault();
              void send(question);
            }}
            // Dropping a file on the box is how most people will do this, and it is the same path as
            // the button. The dragover handler exists only to stop the browser opening the file.
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void attach(event.dataTransfer.files);
            }}
          >
            {(attached.length > 0 || attachNote) && (
              <div className="mcp-attached">
                {attached.map((file) => (
                  <span className="mcp-file" key={file.name}>
                    <b>{file.name}</b>
                    <small>{sizeOf(file.data.length * 0.75)}</small>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => setAttached(attached.filter((held) => held.name !== file.name))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {attachNote && <em>{attachNote}</em>}
              </div>
            )}
            <label className="mcp-attach" title="Attach a screenshot, PDF or spreadsheet">
              <input
                type="file"
                multiple
                accept={ACCEPTS}
                onChange={(event) => {
                  void attach(event.target.files);
                  // Cleared so picking the same file twice in a row still fires a change.
                  event.target.value = "";
                }}
              />
              <span aria-hidden="true">+</span>
              <span className="mcp-attach-label">Attach</span>
            </label>
            <textarea
              ref={inputRef}
              rows={1}
              value={question}
              placeholder="Ask about campaigns, replies, clients, or anyone in the database"
              onChange={(event) => setQuestion(event.target.value)}
              // Enter sends; Shift+Enter breaks the line. This is a question box, and the multi-line
              // case is rare enough that making it the default would cost a keystroke every time.
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(question);
                }
              }}
            />
            <button type="submit" disabled={thinking || (!question.trim() && attached.length === 0)}>
              {thinking ? "Working" : "Ask"}
            </button>
          </form>
        </main>
      </section>
    </div>
  );
}
