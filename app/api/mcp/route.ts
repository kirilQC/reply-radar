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
 * ── The loop ────────────────────────────────────────────────────────────────────────────────────
 * Claude answers, asks for tools, reads the results, and answers again. Real questions need several
 * rounds — "how did Steadywell do this week" is a client lookup, then campaign metrics, then usually
 * the replies themselves — so this iterates rather than making one call. The ceiling exists because a
 * model that has misunderstood a tool will otherwise retry it until the request times out.
 *
 * Tool failures are returned to the model as results, not thrown. "There is no client called Willo,
 * the clients are …" is something Claude can recover from in the next turn; a 502 is not.
 */
import { NextResponse } from "next/server";
import { TOOLS, runTool } from "../../lib/assistant-tools";

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
 * Enough for the questions people actually ask. Six was reached in testing only by a question that
 * spanned every client; past that the model is looping, not working.
 */
const MAX_TURNS = 10;
const MAX_TOKENS = 4096;
/** Long-running by design: ten tool rounds against HeyReach cannot finish in Vercel's ten-second default. */
export const maxDuration = 120;

type Row = Record<string, unknown>;
type Block = Row;
type Turn = { role: "user" | "assistant"; content: string | Block[] };

const text = (value: unknown) => (typeof value === "string" ? value : "");

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
- Reply rates from heyreach_campaign_metrics are already percentages. Do not convert them again.
- Weeks start on Monday. This is read as a working-week report.
- Reply Radar excludes people who messaged the client first — those are not outbound and are not in the database. If someone cannot be found, that may be why.

How to answer:
- Use the tools. Never estimate a number you could have looked up, and never carry a number over from an earlier turn as though you had just checked it.
- If a question names a client you have not resolved, call list_clients first.
- State what you counted and over what period. "142 replies" and "142 replies across all clients since August 1" are different claims.
- When a tool fails, say what failed and what you would need. Do not fill the gap with a guess.
- Be brief. Tables for lists of things, prose for judgements. No preamble.
- You have read access only. If asked to send, pause, tag or change anything, say that this is read-only and describe what you would do instead.`;

/** One Anthropic call. */
async function ask(apiKey: string, messages: Turn[]): Promise<Row> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, tools: TOOLS, messages }),
    signal: AbortSignal.timeout(90_000),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) {
    const error = payload.error && typeof payload.error === "object" ? (payload.error as Row) : {};
    throw new Error(text(error.message) || `Anthropic returned ${response.status}.`);
  }
  return payload;
}

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

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as Row;
  const messages = history(body.messages);
  if (!messages.length || messages.at(-1)?.role !== "user") {
    return NextResponse.json({ ok: false, error: "Ask a question." }, { status: 400 });
  }

  /** What the assistant did, so the UI can show its working rather than asking for trust. */
  const steps: Array<{ tool: string; input: Row; ok: boolean; detail: string }> = [];
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const payload = await ask(apiKey, messages);
      const usage = payload.usage && typeof payload.usage === "object" ? (payload.usage as Row) : {};
      inputTokens += Number(usage.input_tokens) || 0;
      outputTokens += Number(usage.output_tokens) || 0;

      const content = Array.isArray(payload.content) ? (payload.content as Block[]) : [];
      const calls = content.filter((block) => block.type === "tool_use");
      const said = content
        .filter((block) => block.type === "text")
        .map((block) => text(block.text))
        .join("\n")
        .trim();

      if (!calls.length) {
        return NextResponse.json({
          ok: true,
          reply: said || "I could not find an answer to that.",
          steps,
          model: MODEL,
          usage: { inputTokens, outputTokens },
        });
      }

      messages.push({ role: "assistant", content });
      // Tools run together: a question spanning four clients is four independent HeyReach calls, and
      // running them in sequence would multiply a cold start by four.
      const results = await Promise.all(
        calls.map(async (call) => {
          const name = text(call.name);
          const input = call.input && typeof call.input === "object" ? (call.input as Row) : {};
          try {
            const result = await runTool(name, input);
            steps.push({ tool: name, input, ok: true, detail: "" });
            return { type: "tool_result", tool_use_id: text(call.id), content: JSON.stringify(result) };
          } catch (error) {
            const detail = error instanceof Error ? error.message : "The tool failed.";
            steps.push({ tool: name, input, ok: false, detail });
            // Reported as a result, not an error: this is usually a recoverable mistake — a client
            // name that does not exist, a date window with only one end — and the next turn fixes it.
            return { type: "tool_result", tool_use_id: text(call.id), content: detail, is_error: true };
          }
        }),
      );
      messages.push({ role: "user", content: results });
    }

    return NextResponse.json({
      ok: false,
      error: `The assistant used all ${MAX_TURNS} of its tool rounds without reaching an answer. Try asking something narrower.`,
      steps,
    }, { status: 504 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The assistant could not be reached.", steps },
      { status: 502 },
    );
  }
}
