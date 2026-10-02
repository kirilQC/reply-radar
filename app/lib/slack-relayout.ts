// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The last step before a QC Bot answer reaches Slack: a short model call that rewrites the finished answer
 * into the house card shape (verdict, number tiles, at most five two-line items, one footer line, follow-up
 * buttons), changing no figure and no name.
 *
 * Asking the research agent to also obey a strict layout was unreliable: its long system prompt has its own
 * answer rules and it drifted back to paragraphs and "Want me to…?" endings. A separate pass with one job is
 * consistent. If it fails or is slow, the original answer goes out unchanged.
 */

import { DEFAULT_MODEL } from "../../shared/anthropic-model.mjs";

const SYSTEM = `You lay out answers for Slack. You receive a finished answer from an analytics assistant. Rewrite it into exactly this shape, and output only the rewritten answer:

**<Verdict: one sentence, under 120 characters, that answers the question and carries the key number.>**

\`\`\`stats
{"items":[{"label":"<short label>","value":"<figure>","note":"<optional, few words>"}]}
\`\`\`

- 🔴 **<Name or subject>**, <short context> · <one detail, under 14 words>
- 🟡 **<…>**, <…> · <…>

[<Open X in QC Command>](<url from the answer>)

_<One line: date range · source · the single caveat that matters>_

\`\`\`actions
["<follow-up request 1>", "<follow-up request 2>"]
\`\`\`

Rules:
- Never change, round, add or drop a number, name, company, client or date. Every figure you show must appear in the original.
- stats: 2 to 4 tiles, only when the answer has several figures; otherwise omit the block.
- Items: at most 5 (at most 8 when the person asked for a list). Pick the ones that matter most. Use 🔴 for act today, 🟡 this week, 🟢 fine or for information, only when items are things to act on; otherwise no emoji. No "Label: value · Label: value" rows.
- A comparison of two or three things may use a small table instead of items (at most 3 columns, short cells).
- No paragraphs. Caveats collapse into the one italic footer line, or are dropped if they don't change the answer.
- Keep [label](url) links that point to QC Command, at most two, each on its own line.
- actions: 1 to 3 follow-ups the person would plausibly ask next, each under 40 characters, written as what they would type ("All 12 as a CSV", "Same view for Kuddo"). Turn any "Want me to…?" offer in the original into these.
- Keep a \`\`\`export block from the original unchanged at the very end if there is one.
- If the original is an error, a refusal or a one-line answer, return it unchanged.`;

export async function relayoutForSlack(answer: string, question: string, timeoutMs = 20_000): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !answer.trim() || answer.length < 200) return answer;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: "user", content: `Question: ${question || "(not given)"}\n\nAnswer to lay out:\n\n${answer}` }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return answer;
    const payload = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (payload.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    // A rewrite that lost the bold verdict or came back empty is not used.
    return text.startsWith("**") ? text : answer;
  } catch {
    return answer;
  }
}
