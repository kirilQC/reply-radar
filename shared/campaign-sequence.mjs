// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The words a campaign actually sends, pulled out of HeyReach's sequence tree.
 *
 * Lives here rather than in the worker because it is the one part of analytics collection that is pure
 * — a shape in, a shape out, no API and no database — and it is also the part with the most ways to be
 * quietly wrong. Every failure mode is silent: a missed node type leaves the copy blank, a wrong branch
 * shows a chase-up message where the opener should be, and either way the "messaging that performed
 * best" card ranks rates against the wrong words with no error anywhere.
 */

/** Beyond this the tree is malformed and the walk is stopped rather than allowed to run unbounded. */
const MAX_NODES = 200;

/**
 * `{ firstTouch, followUp, steps }` for a sequence root.
 *
 * HeyReach returns a sequence as a linked tree rather than a list: each node carries a `conditionalNode`
 * for "the lead did the thing" and an `unconditionalNode` for "they did not", both of which can be
 * another step or an `END`. Only two of those steps are worth showing next to a set of rates — the note
 * on the connection request, which decides whether anybody accepts, and the first message after they do,
 * which decides whether anybody answers. The rest is chase-up.
 *
 * Walked breadth-first so the shallowest CONNECTION_REQUEST and MESSAGE win, which is the order they
 * would be sent in. `messages[0]` is the A variant; `fallbackMessage` is what goes out when the lead's
 * first name is missing, and is used only when there are no variants at all.
 */
export function sequenceCopy(root) {
  const queue = root && typeof root === "object" ? [root] : [];
  let firstTouch = "";
  let followUp = "";
  let steps = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    const type = String(node.nodeType || "").toUpperCase();
    const payload = node.payload && typeof node.payload === "object" ? node.payload : {};
    const body = String((Array.isArray(payload.messages) && payload.messages[0]) || payload.fallbackMessage || "").trim();
    if (type !== "END") steps += 1;
    if (body) {
      if (type === "CONNECTION_REQUEST" && !firstTouch) firstTouch = body;
      // INMAIL is the same act as MESSAGE from the reader's point of view: the first thing said to
      // somebody who let us in.
      else if ((type === "MESSAGE" || type === "INMAIL") && !followUp) followUp = body;
    }
    for (const branch of [node.conditionalNode, node.unconditionalNode]) {
      if (branch && typeof branch === "object") queue.push(branch);
    }
    if (queue.length > MAX_NODES) break;
  }
  return { firstTouch, followUp, steps };
}
