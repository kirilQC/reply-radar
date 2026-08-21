// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The pure half of the onboarding hub: turning a client name into a slug, the progress maths the bar and
 * the "complete" state both read from, the parent/child grouping the checklist renders, and the text of the
 * Slack update a checkoff posts. No I/O, so `tests/onboarding.test.mjs` drives all of it directly — which
 * matters most for `computeProgress`, because it decides both the bar and whether a client flips to
 * "complete", and for the Slack text, because that is the one thing here a whole channel reads.
 *
 * ── Why progress counts leaves, not every row ────────────────────────────────────────────────────────
 * A step with sub-steps (e.g. "Set up client in Reply Radar", with nine under it) is not itself a unit of
 * work — its nine children are. Counting the parent as well would let a checklist read 10/10 when nine
 * things are done and the parent is auto-ticked, or worse count the same work twice. So a "leaf" (a row no
 * other row is a child of) is the unit, a parent is done exactly when all its leaves are, and the
 * denominator is the number of leaves. A top-level step with no children is itself a leaf and counts once.
 */

/** How far apart sibling positions are seeded, so a step can always be dropped between two others. */
export const POSITION_STEP = 100;

/**
 * A URL-safe slug from a client name: lowercased, runs of anything non-alphanumeric collapsed to a single
 * hyphen, ends trimmed. Empty in, empty out — the caller decides what to do with a name that is all
 * punctuation, rather than this inventing one.
 */
export function slugify(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The set of ids that are somebody's parent. A row whose id is not in it is a leaf.
 * @param {Array<{id?: unknown, parentId?: unknown}>} tasks
 */
function parentIdSet(tasks) {
  const set = new Set();
  for (const task of tasks) {
    const parent = task?.parentId;
    if (parent) set.add(String(parent));
  }
  return set;
}

/**
 * Done-leaves, total-leaves and a whole-number percent for a client's tasks.
 * @param {Array<{id?: unknown, parentId?: unknown, isDone?: unknown}>} tasks
 * @returns {{ doneLeaves: number, totalLeaves: number, pct: number, complete: boolean }}
 */
export function computeProgress(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const parents = parentIdSet(list);
  const leaves = list.filter((task) => task && task.id != null && !parents.has(String(task.id)));
  const totalLeaves = leaves.length;
  const doneLeaves = leaves.filter((task) => Boolean(task.isDone)).length;
  const pct = totalLeaves ? Math.round((doneLeaves / totalLeaves) * 100) : 0;
  // A client with no steps at all is not "complete" — it is unstarted. Completion needs at least one leaf,
  // all of them done, so an empty template can never post a spurious ":tada: fully onboarded".
  return { doneLeaves, totalLeaves, pct, complete: totalLeaves > 0 && doneLeaves === totalLeaves };
}

/**
 * Whether a parent row should read as done: it has children and every one of them is done. A row with no
 * children is a leaf and is not decided here — its own `isDone` is the truth.
 * @param {{id?: unknown}} parent
 * @param {Array<{parentId?: unknown, isDone?: unknown}>} tasks
 */
export function parentIsDone(parent, tasks) {
  const id = parent?.id == null ? "" : String(parent.id);
  if (!id) return false;
  const children = (Array.isArray(tasks) ? tasks : []).filter((task) => String(task?.parentId ?? "") === id);
  return children.length > 0 && children.every((child) => Boolean(child.isDone));
}

/**
 * Tasks grouped for display: top-level steps in position order, each with its own children in position
 * order, and a derived `done` on every node. Rows are copied, not mutated, so a caller can render straight
 * from the result. Orphans (a child whose parent is missing) are surfaced as top-level rather than dropped,
 * so a data problem is visible instead of silently hiding a step.
 * @param {Array<Object>} tasks
 */
export function groupTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const byId = new Set(list.map((task) => String(task?.id ?? "")));
  const byPosition = (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0);
  const isTop = (task) => {
    const parent = task?.parentId ? String(task.parentId) : "";
    return !parent || !byId.has(parent);
  };
  const tops = list.filter(isTop).sort(byPosition);
  return tops.map((top) => {
    const children = list
      .filter((task) => !isTop(task) && String(task.parentId) === String(top.id))
      .sort(byPosition);
    return {
      ...top,
      children,
      // A parent with children is done when they all are; a childless top-level step keeps its own flag.
      done: children.length > 0 ? children.every((child) => Boolean(child.isDone)) : Boolean(top.isDone),
    };
  });
}

/**
 * The next position after a set of siblings — max + one step — so an appended step lands at the end.
 * @param {Array<{position?: unknown}>} siblings
 */
export function nextPosition(siblings) {
  const list = Array.isArray(siblings) ? siblings : [];
  const max = list.reduce((top, item) => Math.max(top, Number(item?.position) || 0), 0);
  return max + POSITION_STEP;
}

/**
 * Evenly spaced positions for a reordered list of sibling ids, so the editor can hand back a new order and
 * get back one position per id (100, 200, 300 …) to persist. Keeps positions integer and well-separated.
 * @param {Array<unknown>} orderedIds
 * @returns {Array<{ id: string, position: number }>}
 */
export function positionsForOrder(orderedIds) {
  return (Array.isArray(orderedIds) ? orderedIds : []).map((id, index) => ({
    id: String(id),
    position: (index + 1) * POSITION_STEP,
  }));
}

/** Trim, and treat a non-string as absent. */
function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The Slack line a single checkoff posts to the internal channel. One line, because a channel reads a
 * stream of these — the client bolded, the step (its parent prefixed with a ›), the running count, and who
 * did it in italics when known. Slack mrkdwn; no mention pills, so nothing here can misfire an @.
 * @param {{clientName?: string, taskTitle?: string, parentTitle?: string, doneBy?: string, doneLeaves?: number, totalLeaves?: number, pct?: number}} input
 */
export function checkoffMessage({ clientName, taskTitle, parentTitle, doneBy, doneLeaves, totalLeaves, pct }) {
  const client = clean(clientName) || "This client";
  const step = clean(parentTitle) ? `${clean(parentTitle)} › *${clean(taskTitle)}*` : `*${clean(taskTitle)}*`;
  const by = clean(doneBy) ? `  ·  _${clean(doneBy)}_` : "";
  return `:white_check_mark:  *${client}* — ${step}  ·  ${doneLeaves}/${totalLeaves} (${pct}%)${by}`;
}

/**
 * The Slack line posted once the last leaf is checked. Deliberately separate from the per-step line so the
 * channel gets one clear "this is finished" rather than a 100% that reads like any other checkoff.
 * @param {{clientName?: string, totalLeaves?: number, doneBy?: string}} input
 */
export function completionMessage({ clientName, totalLeaves, doneBy }) {
  const client = clean(clientName) || "This client";
  const by = clean(doneBy) ? `  ·  _${clean(doneBy)}_` : "";
  return `:tada:  *${client}* is fully onboarded — all ${totalLeaves} steps complete.${by}`;
}
