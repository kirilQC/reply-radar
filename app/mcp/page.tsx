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
 * ── Why answers can be exported ─────────────────────────────────────────────────────────────────
 * The output of "rank these campaigns" or "who needs following up" is usually on its way into a sheet
 * or a client email. CSV lifts the tables straight out of the answer; PDF is the browser's own print
 * path, which is how the Reports tab already does it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
type Message = {
  role: "user" | "assistant";
  content: string;
  entries?: Entry[];
  failed?: boolean;
  askedAt?: string;
};

/**
 * Openers, chosen to teach the surface rather than to demo it.
 *
 * Each one exercises a different part — live HeyReach status, our stored replies, a cross-client
 * total, a per-person lookup — because the question people cannot guess is what this thing can be
 * asked, and four examples answer that faster than any description.
 */
const PROMPTS = [
  "What campaigns are live for Steadywell right now, and when do they run out of leads?",
  "Who replied and hasn't been followed up with yet? Oldest first.",
  "How many replies have we had this month across all clients?",
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
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, live]);

  useEffect(() => {
    if (!thinking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [thinking]);
  const seconds = Math.max(0, Math.floor((now - startedAt.current) / 1000));

  const send = async (raw: string) => {
    const asked = raw.trim();
    if (!asked || thinking) return;
    // The history posted to the server is the one on screen plus this question. Built here rather
    // than read back from state because a state update is not visible to the request that follows it.
    const history = [...messages, { role: "user" as const, content: asked, askedAt: new Date().toISOString() }];
    setMessages(history);
    setQuestion("");
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
    let answer = "";
    /** Consecutive thinking deltas belong to one thought; a tool call ends it. */
    let openThought: { kind: "thinking"; text: string } | null = null;

    const paint = () => setLive({ entries: [...entries], answer });

    try {
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
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
          } else if (event.type === "done") {
            finish({
              role: "assistant",
              content: String(event.reply ?? ""),
              entries: [...entries],
              askedAt: new Date().toISOString(),
            });
          } else if (event.type === "failed") {
            finish({
              role: "assistant",
              content: String(event.error ?? "The assistant could not finish."),
              entries: [...entries],
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

  const downloadCsv = (index: number) => {
    const message = messages[index];
    const asked = questionFor(index);
    const csv = answerToCsv({ question: asked, answer: message.content, askedAt: message.askedAt ?? "" });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(asked, message.askedAt ?? "", "csv");
    link.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Prints one answer.
   *
   * The whole page is hidden by print CSS except the turn marked `is-printing`, so the PDF is the
   * answer and its question rather than a screenshot of a chat app. Cleared on the next tick after
   * `print()` returns, which is when the dialog has closed.
   */
  const downloadPdf = (index: number) => {
    setPrinting(index);
    window.setTimeout(() => {
      window.print();
      setPrinting(null);
    }, 60);
  };

  const copyAnswer = (index: number) => void navigator.clipboard?.writeText(messages[index].content);

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
                Live HeyReach campaigns, senders, sequences and lists, plus every reply, score and
                follow-up Reply Radar has stored. Read-only — nothing here can send, pause or change
                anything. Bigger questions take longer on purpose; you can watch the lookups as they run.
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
                    <Markdown>{message.content}</Markdown>
                  ) : (
                    <div className="mcp-body">{message.content}</div>
                  )}

                  {message.role === "assistant" && !message.failed && message.content && (
                    <div className="mcp-export print-hide">
                      <button onClick={() => copyAnswer(index)}>Copy</button>
                      <button onClick={() => downloadCsv(index)}>CSV</button>
                      <button onClick={() => downloadPdf(index)}>PDF</button>
                    </div>
                  )}
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
                  {live.answer && <Markdown>{live.answer}</Markdown>}
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
          >
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
            <button type="submit" disabled={thinking || !question.trim()}>
              {thinking ? "Working" : "Ask"}
            </button>
          </form>
        </main>
      </section>
    </div>
  );
}
