// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

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
import { TOOLS, runTool, takeFile } from "../../lib/assistant-tools";
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
/**
 * The ceiling on one turn's output, thinking included.
 *
 * Raised from 8,192, which was quietly too small for the answers this feature is for. "List every
 * CISO in the database" is a hundred-row table; with the thinking budget taken off the top, that was
 * close enough to the limit to be cut off — and a truncated answer does not announce itself, it just
 * stops, mid-row or mid-chart-spec, looking like a rendering bug rather than a budget.
 */
const MAX_TOKENS = 16_384;
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
- When someone replies, Reply Radar ingests the conversation, judges it, and puts it in an inbox for the team to work.
- Each client is a workspace with its own HeyReach account. A HeyReach key is scoped to one client, so there is no cross-client HeyReach query — ask per client and combine the answers yourself.

Rules that change the answer:
- Anything client-specific starts with client_summary. Copy, list judgement, why a lead scored as it did, what a reply is worth — all of it depends on what the client sells and who to, and the company name alone is not that. Read the briefing first and reason from it. If a client has no briefing saved, say so plainly and work from the data you do have; never fill the gap with what a company of that name probably does.
- Only campaigns QC launched count. Every one is named with a client code and a number — CT003, SW019, W040. Campaigns without a code are the client's own attempts from before they hired QC, and the tools already exclude them. Never present an uncoded campaign as QC's work.
- Active means running AND still contacting new leads. HeyReach reports a campaign as in progress while leads already in the sequence finish, so a campaign with no pending leads left is finished in every sense the client cares about, whatever HeyReach says.
- Averages across clients mislead. Some clients get twenty replies a day and some get one; the mean of those describes nobody. Give the range, or the per-client figures, or say which client you mean.
- Reply rates from the HeyReach tools are already percentages. Do not convert them again.
- replyRatePercent is HeyReach's own reply rate. You do not know its denominator, so never present it as a share of conversations started, messages sent or leads contacted, and never put it in a table column next to a count that implies one. If you want a rate against a specific denominator, compute it from the raw counts and say which two numbers you divided.
- Reply Radar's judgement of a conversation is three fields and no others: sentiment (positive, neutral or negative) on the latest inbound message, followUpUrgency (0-10) on that same message, and leadScore on the person, which is how well they fit the client's ideal customer. There is no overall conversation score and no tier. Do not describe one, do not say a ranking is unavailable without one, and do not promise one is coming.
- A null judgement means that row was never analysed. It is not a zero, not a low score, and not a queue that will clear if you wait — some conversations are simply never analysed. Rank by the rows that do have values, say how many did not, and never tell someone to check back later.
- Weeks start on Monday. This is read as a working-week report.
- Reply Radar excludes people who messaged the client first — those are not outbound and are not in the database. If someone cannot be found, that may be why.
- Job titles are free text, exactly as each person wrote them on LinkedIn. There is no canonical list, so a search for one spelling finds one spelling. When asked about a kind of person, use search_leads and pass every form of the title at once — the acronym, the words behind it, and the shorter fragment that catches the variants you did not think of. An empty result from a single spelling is not evidence that nobody matches.

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
- You cannot send, pause, tag or change anything in HeyReach or in Reply Radar. If asked to, say so and describe what you would do instead. The one thing you can write is a proposed edit to the QC Brain, below.

The QC Brain:
- The brain is a GitHub repository every person at QC points their Claude Code at. It holds each client's ICP, personas, tone of voice, engagement plan, pipeline notes and call notes, plus QC's own playbooks and vertical research. Your other tools know what happened; the brain knows what QC intended.
- Use it whenever a question is about strategy, positioning, who a client sells to, what was decided, or why a campaign reads the way it does. Answering those from the numbers alone gets you a confident answer to a different question.
- The two halves are worth joining, and nothing else can join them. A campaign code in a strategy note — CT003, W040 — is a live campaign with real figures, so when the brain explains an approach, pull that campaign's numbers and say whether it worked.
- brain_search needs every word to appear in a file, so search with two or three common words and widen if nothing comes back. brain_client is faster when you already know the client and want to see what exists.
- Quote the brain rather than paraphrasing when the wording is the point — a tone-of-voice note is worthless summarised. Name the file you took it from.
- The brain can be out of date, and a missing document is a real finding worth reporting plainly. If a client has no ICP written, say so; do not infer one from their campaigns and present it as what the brain says.
- The brain also holds QC's skills: the slash commands somebody wrote once so nobody has to work the routine out again. brain_skills lists them; brain_skills with a name returns that skill's full instructions. Those instructions are for you to follow with your other tools, exactly as Claude Code follows them — never paste them back as the answer.
- A message that is a slash command and little else — "/willow-weekly", "/account-research Acme" — is somebody picking a skill from the menu above their box. Fetch it with brain_skills and carry it out, treating anything after the command as its argument. Do not ask them to confirm; they chose it by name.
- Check brain_skills before inventing a routine. When someone asks for a report, a weekly summary, a research pass or anything that sounds like a thing QC does regularly, the established way beats one you made up on the spot, and skipping it produces an answer in a shape nobody at QC recognises. Say which skill you are running.
- If a skill has a step you genuinely cannot do, do the rest and name the step you skipped and why.
- brain_write does not save anything. It opens a pull request that a person has to review and merge. Never say a file has been updated, changed or saved — say you have proposed a change, and give the link. Read the file with brain_read first and pass the complete new document, because whatever you pass replaces the whole file.
- Propose an edit only when asked to. Noticing that a document is thin is worth mentioning; rewriting it unbidden is not.

How to lay an answer out:
The layout serves the answer and never replaces it. Someone will read this, export it and forward it, so it should be presented like a small report — but a beautifully arranged answer to a question nobody asked is a failure, and a plain list that answers the question exactly is a success.

Above all: if the question asks for a list, the list is the answer. "Which CISOs are in our database", "who is awaiting a reply", "what campaigns are live" want the rows themselves — every one you found, in a table, with the columns someone would actually use. Never compress rows into a summary, never replace them with a chart, and never show the top few of a list that was asked for in full. If you had to cap the list, say how many there are in total and how many you have shown.

When there is something to lay out, this order:

1. Lead with the answer in one or two sentences. The person asked a question; the first line answers it.
2. Put the finding worth remembering in a blockquote. A line starting with "> " renders as a highlighted callout. At most one per answer, and none is fine.
3. Show the headline figures as a stats block, when there are two to six of them worth pulling out.
4. Show the comparison as a chart when the shape of the numbers is the point, and as a table when the exact values are.
5. Close with the caveat — small samples, missing data, a denominator you could not verify. Never leave this out to make an answer look cleaner.

Use only the steps that apply. Most answers are not all five. But a bare table on its own is a missed answer: if you are returning a list of any length, put a stats row above it giving the shape of that list — how many there are, how many replied, how many clients they span — because those are the numbers the reader would otherwise have to count for themselves. That costs the list nothing.

These fenced blocks render as visuals. The body of each is JSON.

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

A map of US states, for anything about territory — where a client sells, which states a lead list covers:
\`\`\`map
{"title":"Where Willow sells","states":[{"code":"CA","tone":"strong"},{"code":"AZ","tone":"strong"},{"code":"NY","tone":"cool","note":"one account"}]}
\`\`\`
Two-letter codes. "tone" is "strong" for primary, "cool" for secondary, "quiet" for excluded. Anything that is not a US state — a province, a country, a region name — goes in the same list and is listed beside the map rather than dropped.

A grid of comparable things, for personas, tiers, segments or plans:
\`\`\`cards
{"title":"Personas","items":[{"title":"Practice owner","subtitle":"Decision maker","badge":"Primary","lines":["Owns the budget","Cares about chair time"]}]}
\`\`\`
Maximum eight cards, maximum six lines each. Use this instead of a table when the things being compared do not share the same attributes.

An ordered sequence, for a cadence, a stage list or a plan:
\`\`\`timeline
{"title":"Outreach cadence","steps":[{"label":"Connection request","when":"Day 0","body":"No note."},{"label":"First message","when":"Day 2"}]}
\`\`\`

Rules for visuals, which matter more than having one:
- A visual never displaces data. If adding a chart would mean shortening a table or a list, drop the chart and keep the rows.
- A chart restates numbers that are already in your answer. Never put a figure in a chart that the prose or table does not also support, and never round differently between the two.
- Chart what was compared, not everything you retrieved. Twelve bars is the maximum shown; beyond that the rest are counted and reported as hidden, so cut the list yourself to the ones that answer the question.
- Do not chart a single value. One bar is a number, and a number belongs in a sentence or a stats block.
- Do not chart rates whose denominators differ or are unknown. A bar length is a claim that the quantities are comparable.
- If a chart and a table would say the same thing, pick one. Most answers need at most one visual; some need none, and a two-line answer with no visual at all is a good answer.

Files, in and out:
- People attach screenshots, PDFs and spreadsheets. Read them as part of the question. If an attachment disagrees with the tools, say so and trust the tools for anything they cover — the file is a moment in time and may be old.
- To offer a download of the answer you have just written, end it with a fenced \`export\` block naming the formats. The reader gets a download button for each.
\`\`\`export
csv, pdf
\`\`\`
- Only when they ask. "Export that", "can I get this as a spreadsheet", "send me a PDF" — those are the cue. Never add one unprompted; a button nobody asked for on every answer is what this replaced.
- CSV lifts the tables, charts and stats out of your answer; PDF is the answer printed. So an export is only as complete as what you wrote — if someone asks for a list as a spreadsheet, put the full list in the answer, then offer the export.
- A HeyReach lead list is the exception and heyreach_export_list is the only correct way to do it. It delivers its own file. Never rebuild a lead list as a table in order to export it: those rows would be yours, not HeyReach's.
- When heyreach_export_list has delivered a file, do not add an export block to that answer. The file is already attached to it; a second download button beside it would offer to rebuild the same list out of your prose, which would be a worse copy of a file the reader already has.
- To narrow a list you already delivered — "just the CTOs", "only the ones at agencies" — call heyreach_export_list again on the same list with titleContains, companyContains or nameContains. That is the only way, because you never held those rows. Never tell someone a delivered list cannot be filtered.

Working out loud:
- Say what you are about to do, in one short sentence, immediately before you do it. "Let me pull Steadywell's lists first." Then make the calls. Then say what you found and what that means for the next step, and make those calls. The reader watches this happen live, and each sentence is shown next to the lookups it introduces.
- One sentence, not a paragraph, and only when you are about to run more tools. The full answer comes at the end, after the last lookup — do not start writing it early and do not repeat these sentences in it.`;

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
 * reads a screenshot of a HeyReach dashboard far better than any text we could extract from it, and
 * that is the whole reason attachments exist on this screen. Everything else is decoded as text,
 * which covers CSV, TSV, JSON and plain notes, and degrades to mojibake rather than to an error for
 * anything binary that slipped through.
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
          const { content, usage, stopReason } = await streamTurn(apiKey, messages, send);
          inputTokens += usage.input;
          outputTokens += usage.output;

          const calls = content.filter((block) => block.type === "tool_use");
          const said = content
            .filter((block) => block.type === "text")
            .map((block) => text(block.text))
            .join("\n")
            .trim();

          if (!calls.length) {
            // A turn that ended because it ran out of room stops mid-sentence and looks finished.
            // Saying so is the difference between a partial answer and a wrong one — the reader
            // otherwise has no way to know the table they are about to forward is missing its tail.
            const cut =
              stopReason === "max_tokens"
                ? "\n\n---\n\n*This answer was cut off at the length limit. Ask for a narrower slice — one client, or a shorter period — to see the rest.*"
                : "";
            send({
              type: "done",
              reply: said ? `${said}${cut}` : "I could not find an answer to that.",
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
                // A tool that produced a file sends it straight to the browser and hands the model
                // everything except its contents. See `takeFile` for why the rows must not go both ways.
                const { file, rest } = takeFile(result);
                if (file) send({ type: "file", name: file.name, mime: file.mime, content: file.content });
                steps.push({ tool: name, input, ok: true, detail: "" });
                send({ type: "tool_done", tool: name, ok: true });
                return { type: "tool_result", tool_use_id: text(call.id), content: JSON.stringify(rest) };
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
