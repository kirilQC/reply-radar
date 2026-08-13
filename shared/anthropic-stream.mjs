/**
 * Reassembling a streamed Anthropic response.
 *
 * The MCP route streams the model rather than waiting for it, which means it no longer receives
 * finished content blocks — it receives fragments and has to rebuild them. That rebuild has to be
 * exactly right for a reason that is not obvious: the reconstructed blocks are not just what gets
 * displayed, they are what gets sent back as the next request. A tool call whose arguments were
 * assembled wrong is a wrong query, and a thinking block reassembled without its `signature` is
 * rejected outright on the following turn, which would break the loop at the moment it starts using
 * tools.
 *
 * None of that can be tested against the live API from here, and all of it fails quietly. So the
 * logic lives in this module — plain ESM, no imports, no network — and `tests/anthropic-stream.test.mjs`
 * drives it with recorded event sequences, including the ones that only happen at chunk boundaries.
 *
 * The frame helpers are used by the browser too, which parses the same wire format coming out of our
 * own route.
 */

/**
 * Splits an SSE buffer into whole frames, returning the incomplete tail separately.
 *
 * The tail matters. A TCP read can land mid-frame — and reliably does, because tool arguments and
 * thinking text are long — so anything after the last blank line has to be kept and prepended to the
 * next chunk rather than parsed or dropped.
 */
export function splitFrames(buffer) {
  const frames = String(buffer ?? "").split("\n\n");
  return { frames: frames.slice(0, -1), rest: frames.at(-1) ?? "" };
}

/** The JSON payload of one frame, or null for a comment, a bare event line, or malformed JSON. */
export function parseFrame(frame) {
  const line = String(frame ?? "")
    .split("\n")
    .find((part) => part.startsWith("data:"));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(5).trim());
  } catch {
    return null;
  }
}

const text = (value) => (typeof value === "string" ? value : "");
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** Fresh state for one turn. `content` is sparse until every block has started, hence the index keys. */
export function createStreamState() {
  return { content: [], partialJson: new Map(), usage: { input: 0, output: 0 }, stopReason: "" };
}

/**
 * Folds one event into the turn being rebuilt, handing anything worth showing to `onEvent`.
 *
 * Returns nothing; the state is mutated, because this runs once per token and allocating a new state
 * object each time would be a lot of garbage for no benefit.
 *
 * Throws on an `error` event. That is the one case the caller cannot recover from — the model stopped
 * mid-turn — and it has to interrupt the loop rather than be reported as a fragment.
 */
export function applyStreamEvent(state, event, onEvent = () => {}) {
  const index = Number(event?.index) || 0;
  const delta = object(event?.delta);

  switch (event?.type) {
    case "message_start": {
      state.usage.input += Number(object(object(event.message).usage).input_tokens) || 0;
      break;
    }
    case "content_block_start": {
      const block = { ...object(event.content_block) };
      // Seeded so the deltas can concatenate onto a string rather than onto undefined.
      if (block.type === "thinking") block.thinking = "";
      if (block.type === "text") block.text = "";
      if (block.type === "tool_use") state.partialJson.set(index, "");
      state.content[index] = block;
      break;
    }
    case "content_block_delta": {
      const block = state.content[index] ?? {};
      if (delta.type === "thinking_delta") {
        block.thinking = `${text(block.thinking)}${text(delta.thinking)}`;
        onEvent({ type: "thinking", text: text(delta.thinking) });
      } else if (delta.type === "signature_delta") {
        // Never surfaced to the browser: it is a credential for the thinking block, not content.
        block.signature = `${text(block.signature)}${text(delta.signature)}`;
      } else if (delta.type === "text_delta") {
        block.text = `${text(block.text)}${text(delta.text)}`;
        onEvent({ type: "text", text: text(delta.text) });
      } else if (delta.type === "input_json_delta") {
        state.partialJson.set(index, `${state.partialJson.get(index) ?? ""}${text(delta.partial_json)}`);
      }
      state.content[index] = block;
      break;
    }
    case "message_delta": {
      state.stopReason = text(delta.stop_reason) || state.stopReason;
      state.usage.output += Number(object(event.usage).output_tokens) || 0;
      break;
    }
    case "error": {
      throw new Error(text(object(event.error).message) || "The model stream failed.");
    }
  }
}

/**
 * Closes out the turn: parses the accumulated tool arguments and returns the finished blocks.
 *
 * Tool arguments can only be parsed here, because JSON is not valid until its last brace arrives. An
 * empty string means a tool that takes no arguments, which is `{}` and not a failure — and a genuine
 * parse failure also becomes `{}`, so the tool runs, fails on its own validation, and reports
 * something the model can act on rather than crashing the turn.
 */
export function finishStream(state) {
  for (const [index, json] of state.partialJson) {
    const block = state.content[index];
    if (!block) continue;
    try {
      block.input = json.trim() ? JSON.parse(json) : {};
    } catch {
      block.input = {};
    }
  }
  return { content: state.content.filter(Boolean), stopReason: state.stopReason, usage: state.usage };
}
