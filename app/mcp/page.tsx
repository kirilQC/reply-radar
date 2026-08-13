"use client";

/**
 * The MCP tab: one chat box over everything Reply Radar and HeyReach know.
 *
 * ── What the browser is and is not ──────────────────────────────────────────────────────────────
 * A dumb terminal, deliberately. It holds the visible transcript and posts it back on each turn;
 * every decision, every tool call and every API key stays on the server. That is not only a security
 * boundary — it is why the transcript can be plain text. The tool traffic never comes here, so there
 * is nothing to render and nothing to keep in sync.
 *
 * ── Why the tool calls are shown ────────────────────────────────────────────────────────────────
 * An assistant that answers "Steadywell got 47 replies" is indistinguishable from one that guessed,
 * and the first wrong number destroys trust in every right one. So each answer carries the list of
 * tools it actually ran, collapsed by default. It is the cheapest possible audit trail: if the number
 * looks wrong, you can see whether it came from HeyReach, from our database, or from nowhere.
 *
 * A failed tool is shown too. "heyreach_campaigns failed" next to a hedged answer explains the hedge.
 */

import { useEffect, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";

type Step = { tool: string; input: Record<string, unknown>; ok: boolean; detail: string };
type Message = { role: "user" | "assistant"; content: string; steps?: Step[]; failed?: boolean };

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
  "Which of Cotool's campaigns has the best reply rate?",
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

export default function McpPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [thinking, setThinking] = useState(false);
  const [openSteps, setOpenSteps] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, thinking]);

  const send = async (raw: string) => {
    const asked = raw.trim();
    if (!asked || thinking) return;
    // The history posted to the server is the one on screen plus this question. Built here rather
    // than read back from state because a state update is not visible to the request that follows it.
    const history = [...messages, { role: "user" as const, content: asked }];
    setMessages(history);
    setQuestion("");
    setThinking(true);
    try {
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      const payload = await response.json().catch(() => ({}));
      setMessages([
        ...history,
        payload.ok
          ? { role: "assistant", content: String(payload.reply ?? ""), steps: payload.steps ?? [] }
          : {
              role: "assistant",
              content: String(payload.error ?? "The assistant could not be reached."),
              steps: payload.steps ?? [],
              failed: true,
            },
      ]);
    } catch {
      setMessages([
        ...history,
        { role: "assistant", content: "The request did not complete. Check your connection and ask again.", failed: true },
      ]);
    } finally {
      setThinking(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "MCP" }]} />
          <div className="top-actions">
            {messages.length > 0 && (
              <button className="mcp-reset" onClick={() => { setMessages([]); setOpenSteps(null); }}>
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
                anything.
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
                  className={`mcp-turn mcp-${message.role}${message.failed ? " mcp-failed" : ""}`}
                  key={index}
                >
                  <div className="mcp-body">{message.content}</div>
                  {message.steps && message.steps.length > 0 && (
                    <div className="mcp-steps">
                      <button
                        className="mcp-steps-toggle"
                        onClick={() => setOpenSteps(openSteps === index ? null : index)}
                      >
                        {message.steps.length} {message.steps.length === 1 ? "lookup" : "lookups"}
                        {message.steps.some((step) => !step.ok) && <em> · 1 or more failed</em>}
                        <span aria-hidden="true">{openSteps === index ? "▴" : "▾"}</span>
                      </button>
                      {openSteps === index && (
                        <ul>
                          {message.steps.map((step, position) => (
                            <li key={position} className={step.ok ? "" : "mcp-step-failed"}>
                              <b>{toolLabel(step.tool)}</b>
                              {toolArgs(step.input) && <span>{toolArgs(step.input)}</span>}
                              {!step.ok && <i>{step.detail}</i>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </article>
              ))}
              {thinking && (
                <article className="mcp-turn mcp-assistant mcp-working">
                  <div className="mcp-body">
                    <span className="mcp-dots" aria-hidden="true"><i /><i /><i /></span>
                    Looking it up
                  </div>
                </article>
              )}
              <div ref={endRef} />
            </div>
          )}

          <form
            className="mcp-composer"
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
