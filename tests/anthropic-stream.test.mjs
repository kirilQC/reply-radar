// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The streamed turn has to come back out exactly as it went in.
 *
 * What makes this worth testing is not the display — a dropped token in the visible answer is
 * obvious. It is that the reassembled blocks are *resent* as the next request. A tool call whose
 * arguments were glued together wrong queries the wrong thing and reports a confident number for it,
 * and a thinking block missing its `signature` is rejected outright on the next turn, which breaks
 * the loop precisely when it starts using tools. Neither shows up as an error here.
 *
 * The sequences below follow Anthropic's documented event order, including the fragmentation that
 * only appears under load: arguments arriving one brace at a time, and a chunk boundary landing in
 * the middle of a frame.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyStreamEvent,
  createStreamState,
  finishStream,
  parseFrame,
  splitFrames,
} from "../shared/anthropic-stream.mjs";

/** Runs a list of events through a fresh state, collecting whatever was surfaced to the caller. */
function run(events) {
  const state = createStreamState();
  const surfaced = [];
  for (const event of events) applyStreamEvent(state, event, (event_) => surfaced.push(event_));
  return { ...finishStream(state), surfaced };
}

test("a thinking block keeps its text and its signature", () => {
  const { content, surfaced } = run([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Cotool has " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "39 campaigns." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "def" } },
    { type: "content_block_stop", index: 0 },
  ]);
  assert.equal(content[0].thinking, "Cotool has 39 campaigns.");
  // Split across two deltas on purpose: concatenating rather than overwriting is the whole point.
  assert.equal(content[0].signature, "abcdef", "an unsigned thinking block is rejected on the next turn");
  // The signature is a credential for the block, not content, and must never reach the browser.
  assert.deepEqual(surfaced, [
    { type: "thinking", text: "Cotool has " },
    { type: "thinking", text: "39 campaigns." },
  ]);
});

test("tool arguments assembled from JSON fragments parse into the real object", () => {
  const { content } = run([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "heyreach_campaign_metrics" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"clie' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'nt":"Cotool","li' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'mit":300}' } },
    { type: "content_block_stop", index: 0 },
  ]);
  assert.deepEqual(content[0].input, { client: "Cotool", limit: 300 });
  assert.equal(content[0].name, "heyreach_campaign_metrics");
  assert.equal(content[0].id, "tu_1");
});

test("a tool taking no arguments becomes an empty object, not a failure", () => {
  const { content } = run([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "list_clients" } },
    { type: "content_block_stop", index: 0 },
  ]);
  assert.deepEqual(content[0].input, {});
});

test("truncated tool arguments degrade to an empty object rather than throwing", () => {
  // The tool then fails its own validation and tells the model something it can act on, which is a
  // recoverable turn. A parse exception here would kill the whole answer.
  const { content } = run([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "find_person" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"Mar' } },
  ]);
  assert.deepEqual(content[0].input, {});
});

test("several tool calls in one turn stay on their own indexes", () => {
  const { content } = run([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "heyreach_campaigns" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "b", name: "heyreach_senders" } },
    // Interleaved, which is what actually happens: the deltas do not arrive block by block.
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"client":"Cotool"}' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"client":"Steadywell"}' } },
  ]);
  assert.deepEqual(content[0].input, { client: "Cotool" });
  assert.deepEqual(content[1].input, { client: "Steadywell" });
});

test("thinking, prose and a tool call in one turn keep their order", () => {
  // Order matters on the way back: Anthropic requires the thinking block to lead the assistant turn.
  const { content } = run([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check each client." } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Looking at all clients." } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "a", name: "list_clients" } },
  ]);
  assert.deepEqual(content.map((block) => block.type), ["thinking", "text", "tool_use"]);
  assert.equal(content[1].text, "Looking at all clients.");
});

test("usage is summed and the stop reason captured", () => {
  const { usage, stopReason } = run([
    { type: "message_start", message: { usage: { input_tokens: 1200 } } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 95 } },
  ]);
  assert.deepEqual(usage, { input: 1200, output: 95 });
  assert.equal(stopReason, "tool_use");
});

test("an error event stops the turn instead of being reported as content", () => {
  const state = createStreamState();
  assert.throws(
    () => applyStreamEvent(state, { type: "error", error: { message: "Overloaded" } }),
    /Overloaded/,
  );
});

test("unknown events and missing fields are ignored rather than crashing", () => {
  const { content, usage } = run([
    { type: "ping" },
    { type: "content_block_start", index: 0 },
    { type: "content_block_delta", index: 0, delta: {} },
    { type: "message_delta" },
    {},
  ]);
  assert.equal(content.length, 1);
  assert.deepEqual(usage, { input: 0, output: 0 });
});

test("a frame split across two network reads is not lost", () => {
  // The failure this guards against is silent: the tail was previously parsed as if complete, so a
  // long tool argument arriving in two reads produced an empty input and a wrong query.
  const whole = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n';
  const cut = 48;
  let buffer = whole.slice(0, cut);
  let first = splitFrames(buffer);
  assert.deepEqual(first.frames, [], "half a frame is not a frame");
  buffer = first.rest + whole.slice(cut);
  const second = splitFrames(buffer);
  assert.equal(second.frames.length, 1);
  assert.equal(second.rest, "");
  assert.equal(parseFrame(second.frames[0]).delta.text, "hello");
});

test("several frames in one read are all parsed, and the tail is kept", () => {
  const { frames, rest } = splitFrames('data: {"type":"ping"}\n\ndata: {"type":"pong"}\n\ndata: {"par');
  assert.equal(frames.length, 2);
  assert.equal(rest, 'data: {"par');
  assert.deepEqual(frames.map((frame) => parseFrame(frame).type), ["ping", "pong"]);
});

test("comments, event lines and malformed JSON parse to null", () => {
  assert.equal(parseFrame(": keep-alive"), null);
  assert.equal(parseFrame("event: ping"), null);
  assert.equal(parseFrame("data: {not json"), null);
  assert.equal(parseFrame(""), null);
  // Anthropic sends `event:` and `data:` in the same frame; the data line is the one that counts.
  assert.deepEqual(parseFrame('event: ping\ndata: {"type":"ping"}'), { type: "ping" });
});
