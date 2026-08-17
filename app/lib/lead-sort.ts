// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The orders the lead database can be read in.
 *
 * One list, because the two sides of this feature fail differently when they drift. The page offers
 * the labels; the API turns an id into a Postgres `order` clause. If the page offered an id the API
 * did not know, the request would quietly fall back to newest-first and the dropdown would sit there
 * claiming a sort that never happened — the kind of bug nobody reports because it looks like the
 * data just happens to be in that order.
 *
 * Every column named below is a real column on `rr_leads`. `client_names`, `campaign_names` and
 * `sender_names` are generated-stored columns over the rollup inside `raw_data`, which is what makes
 * them sortable in the database rather than only across whatever page is loaded. Replies and last
 * reply are absent on purpose: they live on `rr_conversations`, and until a view joins them to the
 * lead they cannot be ordered from here. Offering them as a per-page sort would have looked identical
 * to these and meant something entirely different.
 */
export type LeadSort = { id: string; label: string; order: string };

/**
 * `created_at.desc` trails every text sort as a tiebreaker.
 *
 * Thousands of leads share a client name, and with no second key Postgres may return ties in a
 * different order on each request. Paging then shows rows twice, or never.
 */
export const LEAD_SORTS: readonly LeadSort[] = [
  { id: "recent", label: "Newest first", order: "created_at.desc" },
  { id: "oldest", label: "Oldest first", order: "created_at.asc" },
  { id: "name-asc", label: "Lead A–Z", order: "name.asc.nullslast,created_at.desc" },
  { id: "name-desc", label: "Lead Z–A", order: "name.desc.nullslast,created_at.desc" },
  { id: "client-asc", label: "Client A–Z", order: "client_names.asc.nullslast,created_at.desc" },
  { id: "client-desc", label: "Client Z–A", order: "client_names.desc.nullslast,created_at.desc" },
  { id: "campaign-asc", label: "Campaign A–Z", order: "campaign_names.asc.nullslast,created_at.desc" },
  { id: "campaign-desc", label: "Campaign Z–A", order: "campaign_names.desc.nullslast,created_at.desc" },
  { id: "sender-asc", label: "Sender A–Z", order: "sender_names.asc.nullslast,created_at.desc" },
  { id: "sender-desc", label: "Sender Z–A", order: "sender_names.desc.nullslast,created_at.desc" },
];

/** The default, and the one the dropdown shows as its placeholder rather than as an entry. */
export const DEFAULT_LEAD_SORT = LEAD_SORTS[0];

/**
 * The `order` clause for a requested sort id.
 *
 * An unknown id — a stale bookmark, a hand-edited query string — falls back to the default rather
 * than erroring. There is nothing a caller could do with a 400 here that is better than the table
 * appearing in its usual order.
 */
export const leadSortOrder = (id: string | null | undefined) =>
  LEAD_SORTS.find((sort) => sort.id === (id ?? "").trim())?.order ?? DEFAULT_LEAD_SORT.order;
