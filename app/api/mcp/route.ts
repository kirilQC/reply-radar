// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The assistant behind the MCP tab: Claude, with access to everything Reply Radar knows.
 *
 * ── Why this is not actually MCP, and why the tab says MCP anyway ────────────────────────────────
 * MCP is a protocol between two servers. HeyReach runs one; a host like Claude Code connects to it
 * and discovers its tools at runtime, which is the whole point — neither side needs to know about the
 * other in advance.
 *
 * A browser cannot be that host. An MCP session is a stateful server-to-server connection, and
 * holding one from the page would mean shipping each client's HeyReach key to the browser, which is
 * not negotiable. So the host has to be this route either way — and once it is, the protocol layer
 * buys nothing: Anthropic's API accepts tool definitions directly, and the HeyReach calls are already
 * written in this repo. Going direct also means every answer inherits rules HeyReach knows nothing
 * about, above all the campaign-code filter — HeyReach's own MCP server would happily report on a
 * client's pre-engagement campaigns as though QC had run them.
 *
 * The tab is called MCP because that is what the team calls this capability, and a label nobody
 * recognises is worse than one that is technically imprecise.
 *
 * ── Where the assistant itself lives ────────────────────────────────────────────────────────────
 * The system prompt, the tool loop and the streamed Anthropic turn are in `app/lib/assistant-run.ts`,
 * because this route is no longer their only caller — the Slack events endpoint runs the same agent
 * for an @-mention of QC Bot. This file is now only the browser's side of it: it parses the page's
 * message history, turns each event `runAgent` emits into an SSE frame, and writes the final answer.
 *
 * ── What the assistant can and cannot write ─────────────────────────────────────────────────────
 * `assistant-tools.ts` is an allowlist, not an instruction: nothing here can act unless a tool exists
 * for it. Almost everything is read-only. The two exceptions are narrow and deliberate — `brain_write`
 * opens a pull request a person must merge, and the Airtable tools add or update rows in a client's own
 * base (there is no delete, on purpose). Both are in the tool registry, so they are the same act of
 * deliberate exposure that every other capability is, rather than something a cleverly worded prompt
 * can reach.
 *
 * ── Why this streams, and why it is allowed to take its time ─────────────────────────────────────
 * The first version returned one JSON object at the end and answered in three seconds off a single
 * tool call — and the speed was the problem: the question deserved a check of scale and status before
 * ranking anything. So the budget went up and the response became a stream, which is what makes a
 * ninety-second answer bearable: extended thinking and each tool call are pushed to the browser as
 * they happen. Streaming also removes a real failure mode — a buffered response that exceeds the
 * platform's limit is lost entirely; a stream has already delivered everything up to the cut.
 */
import {
  MODEL,
  MAX_TURNS,
  runAgent,
  type AgentEvent,
  type Block,
  type Row,
  type Turn,
} from "../../lib/assistant-run";

/**
 * The real ceiling, not the one we would like.
 *
 * Vercel's limit is a property of the plan and a larger number is **silently clamped**, not rejected.
 * On Pro the function may run to three hundred seconds, so that is the ceiling the loop works to:
 * `TOOL_DEADLINE_MS` inside `runAgent` stops it starting new tool rounds in time to write an answer
 * from what it already has. This and the Slack route's ceiling move together — both are the same agent.
 */
export const maxDuration = 300;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The image formats Anthropic accepts. Anything else is offered to the model as text. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/**
 * How much of an attached text file is passed on. A CSV export of a whole audience is megabytes and
 * reading the first slice of it answers the question people actually ask of a spreadsheet they just
 * dropped in; reading all of it would leave no room for the answer.
 */
const TEXT_CHARS = 120_000;

/**
 * Files the person attached, as content blocks.
 *
 * PDFs and images go to Anthropic in their own formats rather than being converted here — the model
 * reads a screenshot of a HeyReach dashboard far better than any text we could extract from it. Everything
 * else is decoded as text, which covers CSV, TSV, JSON and plain notes, and degrades to mojibake rather
 * than to an error for anything binary that slipped through.
 */
function attachments(raw: unknown): Block[] {
  const blocks: Block[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const row = entry && typeof entry === "object" ? (entry as Row) : {};
    const name = text(row.name) || "attachment";
    const mime = text(row.mime);
    const data = text(row.data);
    if (!data) continue;
    if (IMAGE_TYPES.has(mime)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mime, data } });
    } else if (mime === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: mime, data }, title: name });
    } else {
      const body = Buffer.from(data, "base64").toString("utf8");
      const cut = body.length > TEXT_CHARS ? `\n\n[…truncated at ${TEXT_CHARS} characters]` : "";
      blocks.push({ type: "text", text: `Attached file "${name}":\n\n${body.slice(0, TEXT_CHARS)}${cut}` });
    }
  }
  return blocks;
}

const asBlocks = (content: string | Block[]): Block[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

/**
 * Trims the conversation the browser sent.
 *
 * Only the prose and the attachments are kept. The tool blocks from previous turns are deliberately
 * dropped: they are the bulk of the tokens, they are stale the moment anything changes, and a model
 * that can still see last turn's campaign numbers will quote them instead of looking again. The
 * reasoning survives in the assistant's own prose, which is the part worth remembering.
 */
function history(raw: unknown): Turn[] {
  const turns = (Array.isArray(raw) ? raw : []).slice(-20);
  const messages: Turn[] = [];
  for (const entry of turns) {
    const row = entry && typeof entry === "object" ? (entry as Row) : {};
    const role = row.role === "assistant" ? "assistant" : "user";
    const said = text(row.content).trim();
    const files = role === "user" ? attachments(row.files) : [];
    if (!said && !files.length) continue;
    // The files lead, and a question with nothing but a file still gets a sentence: a turn of pure
    // attachments reads as "here" and the model has to guess what was wanted.
    const blocks: Block[] = [...files, { type: "text", text: said || "What is in this file?" }];
    const previous = messages.at(-1);
    // Anthropic rejects two consecutive turns from the same role, which a dropped empty turn can cause.
    if (previous?.role === role) previous.content = [...asBlocks(previous.content), ...blocks];
    else messages.push({ role, content: files.length ? blocks : said });
  }
  return messages;
}

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as Row;
  const messages = history(body.messages);
  if (!messages.length || messages.at(-1)?.role !== "user") {
    return Response.json({ ok: false, error: "Ask a question." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      /**
       * One SSE frame. Wrapped in a try because the browser can close the tab mid-answer, and an
       * enqueue on a closed controller throws — which would otherwise surface as a crash in the logs
       * for something that is not a fault.
       */
      const send = (event: Row) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* the reader is gone; nothing left to tell it */
        }
      };

      // Each event the loop emits becomes an SSE frame. `stream` carries the model's live thinking and
      // text deltas straight through; the rest are the tool lifecycle the UI draws step markers from.
      const emit = (event: AgentEvent) => {
        switch (event.type) {
          case "stream":
            send(event.event);
            break;
          case "tool":
            send({ type: "tool", tool: event.tool, input: event.input });
            break;
          case "tool_done":
            send({ type: "tool_done", tool: event.tool, ok: event.ok, ...(event.detail ? { detail: event.detail } : {}) });
            break;
          case "file":
            send({ type: "file", name: event.name, mime: event.mime, content: event.content });
            break;
        }
      };

      try {
        const result = await runAgent({ apiKey, messages, emit });

        if (result.maxedTurns) {
          send({
            type: "failed",
            error: `The assistant used all ${MAX_TURNS} of its tool rounds without reaching an answer. Try asking something narrower.`,
            steps: result.steps,
          });
          controller.close();
          return;
        }

        // A turn that ended because it ran out of room stops mid-sentence and looks finished. Saying so
        // is the difference between a partial answer and a wrong one — the reader otherwise has no way
        // to know the table they are about to forward is missing its tail.
        const cut =
          result.stopReason === "max_tokens"
            ? "\n\n---\n\n*This answer was cut off at the length limit. Ask for a narrower slice — one client, or a shorter period — to see the rest.*"
            : result.outOfTime
              ? `\n\n---\n\n*Answered from ${result.steps.length} lookup${result.steps.length === 1 ? "" : "s"} — the time limit for one question was reached, so it stopped researching to write this. Ask for a narrower slice to let it look further.*`
              : "";
        send({
          type: "done",
          reply: result.reply ? `${result.reply}${cut}` : "I could not find an answer to that.",
          steps: result.steps,
          model: MODEL,
          usage: result.usage,
        });
      } catch (error) {
        send({
          type: "failed",
          error: error instanceof Error ? error.message : "The assistant could not be reached.",
          steps: [],
        });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and some proxies buffer streamed responses by default, which would hold every event
      // until the answer finished and quietly undo the point of streaming.
      "x-accel-buffering": "no",
    },
  });
}
