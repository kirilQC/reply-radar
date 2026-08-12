/**
 * The three-page rule.
 *
 * A client report that runs to ten pages does not get read, and the version of this feature that
 * shipped first did exactly that: every section rendered as its own sheet, so eleven ticked boxes
 * produced a thirteen-page PDF. The packing here is what replaced that, and it is worth testing
 * because it is invisible — the only symptom of it going wrong is a number next to an export button
 * that quietly stops matching the document.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PAGE_CAPACITY,
  PAGE_LIMIT,
  SECTION_WEIGHTS,
  packPages,
  paginate,
  suggestTrim,
  weightOf,
} from "../shared/report-pagination.mjs";
import { BUILT_IN_TEMPLATES, SECTIONS } from "../app/lib/report-templates.ts";

const weightOfPage = (page) => page.reduce((total, section) => total + weightOf(section), 0);

test("every section the UI offers has a declared weight", () => {
  // weightOf falls back to 3 for anything unknown, which would silently under-count a new section and
  // let a four-page report claim to be three.
  for (const section of SECTIONS) {
    assert.ok(
      Object.hasOwn(SECTION_WEIGHTS, section.id),
      `${section.id} is selectable but has no weight, so it would be costed at the fallback`,
    );
  }
});

test("no built-in template exceeds the page limit", () => {
  for (const template of BUILT_IN_TEMPLATES) {
    assert.ok(
      template.pages.length <= PAGE_LIMIT,
      `${template.name} lays out ${template.pages.length} pages, over the limit of ${PAGE_LIMIT}`,
    );
  }
});

test("built-in template layouts fit the capacity the meter measures against", () => {
  // This is the calibration link between the two halves of the feature. Templates declare their own
  // pages, so they are never packed — but if a hand-designed page would not fit the weight model, the
  // model is wrong, and "Build your own" would refuse layouts that demonstrably print fine.
  for (const template of BUILT_IN_TEMPLATES) {
    template.pages.forEach((page, index) => {
      assert.ok(
        weightOfPage(page) <= PAGE_CAPACITY,
        `${template.name} page ${index + 1} weighs ${weightOfPage(page)}, over the ${PAGE_CAPACITY} a page holds`,
      );
    });
  }
});

test("packing keeps every section, in the order given", () => {
  const sections = ["executive-summary", "kpis", "trend", "campaigns", "senders", "top-leads"];
  assert.deepEqual(packPages(sections).flat(), sections);
});

test("the cover and the methodology note are not selectable sections", () => {
  // Neither is a choice any more. The cover is printed in front of every PDF whatever the layout says, and
  // the methodology note is gone for good — leaving either in the picker would offer a decision that has
  // already been made, and leaving a weight behind would let a stale saved layout be costed as if it fit.
  for (const gone of ["cover", "methodology"]) {
    assert.ok(!SECTIONS.some((section) => section.id === gone), `${gone} should not be offered as a section`);
    assert.ok(!Object.hasOwn(SECTION_WEIGHTS, gone), `${gone} should not carry a page weight`);
  }
});

test("packing fills a page before starting the next", () => {
  for (const page of packPages(Object.keys(SECTION_WEIGHTS))) {
    // A page may only be over capacity if a single section is bigger than a whole page.
    assert.ok(
      weightOfPage(page) <= PAGE_CAPACITY || page.length === 1,
      `a page of ${page.join(", ")} weighs ${weightOfPage(page)} with room to have split`,
    );
  }
});

test("a section heavier than a page still gets a page rather than being dropped", () => {
  const heaviest = Object.entries(SECTION_WEIGHTS).sort((a, b) => b[1] - a[1])[0][0];
  const pages = packPages([heaviest]);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0], [heaviest]);
});

test("the default build-your-own selection is inside the limit", () => {
  // The default has to fit, or the page meter greets everyone with a warning about a selection they
  // never made. This is the regression that produced the ten-page report.
  const defaults = ["executive-summary", "kpis", "trend", "campaigns", "senders", "top-leads"];
  const budget = paginate(defaults);
  assert.equal(budget.withinLimit, true, `the default selection needs ${budget.pageCount} pages`);
  assert.equal(budget.overflowPages, 0);
});

test("ticking everything reports the overflow instead of truncating", () => {
  const budget = paginate(SECTIONS.map((section) => section.id));
  assert.ok(budget.pageCount > PAGE_LIMIT, "every section at once should not fit in three pages");
  assert.equal(budget.withinLimit, false);
  assert.equal(budget.overflowPages, budget.pageCount - PAGE_LIMIT);
  // Nothing is silently lost: the caller is told the real count and can decide.
  assert.equal(budget.pages.flat().length, SECTIONS.length);
});

test("the trim suggestion actually brings a selection back inside the limit", () => {
  const everything = SECTIONS.map((section) => section.id);
  const trim = suggestTrim(everything);
  assert.ok(trim.length, "an over-limit selection should get a suggestion");
  const remaining = everything.filter((section) => !trim.includes(section));
  assert.equal(paginate(remaining).withinLimit, true, `dropping ${trim.join(", ")} still does not fit`);
});

test("the trim suggestion never touches what makes it a report", () => {
  const trim = suggestTrim(SECTIONS.map((section) => section.id));
  for (const protectedSection of ["intro", "executive-summary"]) {
    assert.ok(!trim.includes(protectedSection), `${protectedSection} must never be suggested for removal`);
  }
});

test("a selection already within the limit is asked to drop nothing", () => {
  assert.deepEqual(suggestTrim(["intro", "executive-summary", "kpis"]), []);
});
