/**
 * The assistant behind the MCP tab: Claude, with read access to everything Reply Radar knows.
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
 * The cost of going direct is that a new HeyReach endpoint has to be added by hand rather than
 * appearing on its own. Read-only, that surface barely moves.
 *
 * The tab is called MCP because that is what the team calls this capability, and a label nobody
 * recognises is worse than one that is technically imprecise.
 *
 * ── Read-only is structural ─────────────────────────────────────────────────────────────────────
 * `assistant-tools.ts` defines no write operation. Nothing here can send a message, pause a campaign
 * or delete a row, no matter how the question is phrased, because the capability does not exist in
 * the process. That is deliberately not enforced by asking the model nicely.
 *
 * ── Why this streams, and why it is allowed to take its time ─────────────────────────────────────
 * The first version returned one JSON object at the end. It answered "which of Cotool's campaigns has
 * the best reply rate" in three seconds off a single tool call, and the speed was the problem: the
 * question deserved a check of scale and status before ranking anything, and there was no way to see
 * that it had skipped that until the answer looked wrong.
 *
 * So two things changed together. The budget went up — more tool rounds, more tokens, a longer wall
 * clock — because for this feature a slow right answer beats a fast plausible one, and thoroughness
 * is now stated as the priority in the prompt rather than left to the model's taste. And the response
 * became a stream, which is what makes the first change bearable: extended thinking and each tool
 * call are pushed to the browser as they happen, so a question that takes ninety seconds shows ninety
 * seconds of work instead of a spinner.
 *
 * Streaming also removes a real failure mode. A buffered response that exceeds the platform's limit
 * is lost entirely; a stream has already delivered everything up to the cut.
 *
 * Tool failures are returned to the model as results, not thrown. "There is no client called Willo,
 * the clients are …" is something Claude can recover from in the next turn; a 502 is not.
 */
import { TOOLS, runTool } from "../../lib/assistant-tools";
import {
  applyStreamEvent as applyEvent,
  createStreamState,
  finishStream,
  parseFrame,
  splitFrames,
} from "../../../shared/anthropic-stream.mjs";

/**
 * Sonnet rather than the Haiku the rest of the app uses.
 *
 * Everything else here is one-shot classification — score this lead, draft this reply — where Haiku
 * is the right call. This is an agentic loop that has to choose tools, notice that an answer looks
 * wrong and go back for more, and the difference in that specific ability is large enough to change
 * whether the feature works at all. It also runs a handful of times a day, not once per inbound
 * message, so the cost profile is completely different.
 */
const MODEL = "claude-sonnet-4-6";
/**
 * Deliberately generous. A question like "analyse every campaign we have ever launched" is one round
 * per client to get metrics, more to check status and senders, and more again to read the replies
 * behind a number that looks off — thirty rounds is a real research task, not a loop.
 *
 * The ceiling still exists, because a model that has misunderstood a tool will otherwise retry it
 * until the platform kills the request, and a stream that dies mid-sentence is worse than one that
 * stops and says why.
 */
const MAX_TURNS = 30;
const MAX_TOKENS = 8_192;
/**
 * Extended thinking, on for two reasons. It measurably improves multi-step tool choice, which is the
 * entire job here. And it is the only honest source for the running commentary the UI shows — the
 * alternative would be inventing status lines on the client, which would describe what we assume the
 * model is doing rather than what it is actually reasoning about.
 */
const THINKING_BUDGET = 3_072;
/**
 * Long-running by design. Vercel's limit depends on the plan; if a deployment is ever rejected for
 * this value, lower it rather than trimming MAX_TURNS — the stream degrades gracefully at the cut,
 * and the tool budget is what makes the answers right.
 */
export const maxDuration = 300;

type Row = Record<string, unknown>;
type Block = Row;
type Turn = { role: "user" | "assistant"; content: string | Block[] };

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The reassembler is plain `.mjs`, so its callback parameter is inferred from a `() => {}` default and
 * TS reads it as taking no arguments. Stated once here; `tests/anthropic-stream.test.mjs` is what
 * actually holds the module to this signature.
 */
const applyStreamEvent = applyEvent as (
  state: unknown,
  event: Row,
  onEvent?: (surfaced: Row) => void,
) => void;

/**
 * What Claude needs to know that the tool descriptions cannot say.
 *
 * Everything here is a rule that would otherwise produce a confident wrong answer: an average across
 * clients that means nothing, a campaign the client ran themselves credited to QC, a percentage
 * printed as a fraction. The tool descriptions cover *what* each tool returns; this covers what the
 * numbers mean.
 */
const SYSTEM = `You are the Reply Radar assistant. Reply Radar belongs to QC, an agency that runs LinkedIn outbound for startup clients. You answer questions about that work using the tools you have been given.

What the system is:
- QC runs campaigns in HeyReach on each client's behalf, from LinkedIn accounts belonging to the client's team.
- When someone replies, Reply Radar ingests the conversation, scores it, and puts it in an inbox for the team to work.
- Each client is a workspace with its own HeyReach account. A HeyReach key is scoped to one client, so there is no cross-client HeyReach query — ask per client and combine the answers yourself.

Rules that change the answer:
- Only campaigns QC launched count. Every one is named with a client code and a number — CT003, SW019, W040. Campaigns without a code are the client's own attempts from before they hired QC, and the tools already exclude them. Never present an uncoded campaign as QC's work.
- Active means running AND still contacting new leads. HeyReach reports a campaign as in progress while leads already in the sequence finish, so a campaign with no pending leads left is finished in every sense the client cares about, whatever HeyReach says.
- Averages across clients mislead. Some clients get twenty replies a day and some get one; the mean of those describes nobody. Give the range, or the per-client figures, or say which client you mean.
- Reply rates from the HeyReach tools are already percentages. Do not convert them again.
- replyRatePercent is HeyReach's own reply rate. You do not know its denominator, so never present it as a share of conversations started, messages sent or leads contacted, and never put it in a table column next to a count that implies one. If you want a rate against a specific denominator, compute it from the raw counts and say which two numbers you divided.
- Weeks start on Monday. This is read as a working-week report.
- Reply Radar excludes people who messaged the client first — those are not outbound and are not in the database. If someone cannot be found, that may be why.

How thoroughly to work:
- Thoroughness matters more than speed here. Taking two minutes and thirty tool calls to be right is correct; answering in three seconds off one lookup is not. Nobody is waiting on a stopwatch.
- Never answer a question about "every", "all", "across our clients" or "which is best" from a single tool call. Enumerate: call list_clients, then query each client in turn.
- Before ranking anything by a rate, look at the volume behind each rate and say so. A 75% reply rate on four conversations is noise and presenting it as the winner is a wrong answer even though the arithmetic is right.
- When a number looks surprising, check it against a second source before reporting it. Our database and HeyReach are independent; that is what makes the check worth doing.
- Ask for the rows you need. The list tools take a limit — if analysing hundreds of conversations is what the question requires, request hundreds rather than sampling the default and generalising.
- Do not stop early because you have enough for a plausible answer. Stop when you have enough for a correct one.

How to answer:
- Use the tools. Never estimate a number you could have looked up, and never carry a number over from an earlier turn as though you had just checked it.
- If a question names a client you have not resolved, call list_clients first.
- State what you counted and over what period. "142 replies" and "142 replies across all clients since August 1" are different claims.
- When a tool fails, say what failed and what you would need. Do not fill the gap with a guess.
- Markdown is rendered, so use it. Tables for anything with rows and columns, bold for the figure that answers the question, prose for judgement. Keep tables tight — the columns someone asked about, not every column you retrieved.
- Be brief in prose and complete in data. No preamble, no restating the question.
- You have read access only. If asked to send, pause, tag or change anything, say that this is read-only and describe what you would do instead.

How to lay an answer out:
You are not writing a chat message, you are producing a small report that someone will read, export and forward. Build it in this order.

1. Lead with the answer in one or two sentences. The person asked a question; the first line answers it.
2. Put the finding worth remembering in a blockquote. A line starting with "> " renders as a highlighted callout. Use one per answer, never more.
3. Show the headline figures as a stats block, when there are two to six of them worth pulling out.
4. Show the comparison as a chart when the shape of the numbers is the point, and as a table when the exact values are.
5. Close with the caveat — small samples, missing data, a denominator you could not verify. Never leave this out to make an answer look cleaner.

Two fenced blocks render as visuals. The body of each is JSON.

A stats row, for headline figures:
\`\`\`stats
{"items":[{"label":"Replies","value":"479","note":"all time"},{"label":"Best campaign","value":"CT050","tone":"positive"}]}
\`\`\`
Values are strings and are printed exactly as you write them, so format them yourself. \`note\` and \`tone\` are optional; tone is "positive", "negative" or "warn".

A chart:
\`\`\`chart
{"type":"bar","title":"Reply rate by campaign","caption":"Cotool, all time","unit":"%","series":[{"label":"CT050","value":12.5,"note":"48 conversations"}]}
\`\`\`
- "bar" is a horizontal ranking. Use it for comparing named things — campaigns, clients, senders. It is the right choice almost every time, and it is the only one that handles long names.
- "column" is vertical bars in sequence. Use it only for time: replies per day, per week, per month, in chronological order.
- "split" divides a whole into parts, as one stacked bar. Use it only when the parts genuinely sum to something — positive/neutral/negative replies, a status breakdown. Never use it to compare separate quantities.
- "value" must be a number. "unit" is "%" for rates and omitted for counts. "note" carries the volume behind a rate and you should almost always give it.

Rules for visuals, which matter more than having one:
- A chart restates numbers that are already in your answer. Never put a figure in a chart that the prose or table does not also support, and never round differently between the two.
- Chart what was compared, not everything you retrieved. Twelve bars is the maximum shown; beyond that the rest are counted and reported as hidden, so cut the list yourself to the ones that answer the question.
- Do not chart a single value. One bar is a number, and a number belongs in a sentence or a stats block.
- Do not chart rates whose denominators differ or are unknown. A bar length is a claim that the quantities are comparable.
- If a chart and a table would say the same thing, pick one. Most answers need at most one visual; some need none, and a two-line answer with no visual at all is a good answer.`;

/**
 * Trims the conversation the browser sent.
 *
 * Only the plain text is kept. The tool blocks from previous turns are deliberately dropped: they are
 * the bulk of the tokens, they are stale the moment anything changes, and a model that can still see
 * last turn's campaign numbers will quote them instead of looking again. The reasoning survives in
 * the assistant's own prose, which is the part worth remembering.
 */
function history(raw: unknown): Turn[] {
  const turns = (Array.isArray(raw) ? raw : []).slice(-20);
  const messages: Turn[] = [];
  for (const entry of turns) {
    const row = entry && typeof entry === "object" ? (entry as Row) : {};
    const role = row.role === "assistant" ? "assistant" : "user";
    const content = text(row.content).trim();
    if (!content) continue;
    // Anthropic rejects two consecutive turns from the same role, which a dropped empty turn can cause.
    if (messages.at(-1)?.role === role) messages[messages.length - 1].content = `${messages.at(-1)!.content}\n\n${content}`;
    else messages.push({ role, content });
  }
  return messages;
}

/**
 * One streamed Anthropic call, reassembled into the content array the next turn has to send back.
 *
 * Anthropic's stream arrives as deltas per content block; this rebuilds the blocks while handing each
 * fragment to `onEvent` as it lands. Both halves matter: the fragments are the live commentary, and
 * the rebuilt array is what the conversation is made of.
 *
 * Thinking blocks are reassembled with their `signature` intact. That is not optional — a thinking
 * block replayed without its signature is rejected on the next request, which would break the loop at
 * exactly the point where it starts using tools.
 */
async function streamTurn(
  apiKey: string,
  messages: Turn[],
  onEvent: (event: Row) => void,
): Promise<{ content: Block[]; stopReason: string; usage: { input: number; output: number } }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      // Temperature is deliberately unset: extended thinking requires the default.
      thinking: { type: "enabled", budget_tokens: THINKING_BUDGET },
      stream: true,
    }),
    signal: AbortSignal.timeout(240_000),
    cache: "no-store",
  });

  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => ({}))) as Row;
    const error = payload.error && typeof payload.error === "object" ? (payload.error as Row) : {};
    throw new Error(text(error.message) || `Anthropic returned ${response.status}.`);
  }

  // The reassembly itself is in `shared/anthropic-stream.mjs` so it can be tested against recorded
  // event sequences — it is the one part of this route that cannot be exercised without the live API
  // and that fails silently when wrong.
  const state = createStreamState();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = splitFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      const event = parseFrame(frame);
      if (event) applyStreamEvent(state, event, onEvent);
    }
  }

  return finishStream(state) as { content: Block[]; stopReason: string; usage: { input: number; output: number } };
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

      const steps: Array<{ tool: string; input: Row; ok: boolean; detail: string }> = [];
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        for (let turn = 0; turn < MAX_TURNS; turn += 1) {
          const { content, usage } = await streamTurn(apiKey, messages, send);
          inputTokens += usage.input;
          outputTokens += usage.output;

          const calls = content.filter((block) => block.type === "tool_use");
          const said = content
            .filter((block) => block.type === "text")
            .map((block) => text(block.text))
            .join("\n")
            .trim();

          if (!calls.length) {
            send({
              type: "done",
              reply: said || "I could not find an answer to that.",
              steps,
              model: MODEL,
              usage: { inputTokens, outputTokens },
            });
            controller.close();
            return;
          }

          messages.push({ role: "assistant", content });
          // Tools run together: a question spanning every client is one HeyReach call per client, and
          // running them in sequence would multiply a cold start by the number of clients.
          const results = await Promise.all(
            calls.map(async (call) => {
              const name = text(call.name);
              const input = call.input && typeof call.input === "object" ? (call.input as Row) : {};
              send({ type: "tool", tool: name, input });
              try {
                const result = await runTool(name, input);
                steps.push({ tool: name, input, ok: true, detail: "" });
                send({ type: "tool_done", tool: name, ok: true });
                return { type: "tool_result", tool_use_id: text(call.id), content: JSON.stringify(result) };
              } catch (error) {
                const detail = error instanceof Error ? error.message : "The tool failed.";
                steps.push({ tool: name, input, ok: false, detail });
                send({ type: "tool_done", tool: name, ok: false, detail });
                // Reported as a result, not an error: this is usually a recoverable mistake — a client
                // name that does not exist, a date window with only one end — and the next turn fixes it.
                return { type: "tool_result", tool_use_id: text(call.id), content: detail, is_error: true };
              }
            }),
          );
          messages.push({ role: "user", content: results });
        }

        send({
          type: "failed",
          error: `The assistant used all ${MAX_TURNS} of its tool rounds without reaching an answer. Try asking something narrower.`,
          steps,
        });
      } catch (error) {
        send({
          type: "failed",
          error: error instanceof Error ? error.message : "The assistant could not be reached.",
          steps,
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
