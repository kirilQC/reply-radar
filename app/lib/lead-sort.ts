// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The orders the lead database can be read in.
 *
 * One list, because the two sides of this feature fail differently when they drift. The page offers
 * the labels; the API turns an id into a Postgres `order` clause. If the page offered an id the API
 * did not know, the request would quietly fall back to the default and the dropdown would sit there
 * claiming a sort that never happened — the kind of bug nobody reports because it looks like the
 * data just happens to be in that order.
 *
 * Every column named below is a real column on `rr_lead_index`. `client_names`, `campaign_names` and
 * `sender_names` are generated-stored columns over the rollup inside `raw_data`; `last_reply_at` and
 * `reply_count` are the view's join onto `rr_conversations`/`rr_messages`. All of them are sortable in
 * the database rather than only across whatever page is loaded.
 *
 * The rule the list obeys: a sort must order by the column the reader can see. The table's date
 * column shows the last reply, not when the row was inserted, so "Newest first" has to mean
 * `last_reply_at`. Ordering by `created_at` under that label is what made the first version look
 * broken — the dates on screen came back in no visible order. `created_at` is still offered, under
 * labels that say what it is.
 */
export type LeadSort = { id: string; label: string; order: string };

/**
 * `created_at.desc` trails every sort that is not itself unique, as a tiebreaker.
 *
 * Leads share a client name, a reply count, and — for everything never replied to — a null last
 * reply. With no second key Postgres may return ties in a different order on each request, and
 * paging then shows rows twice, or never.
 */
export const LEAD_SORTS: readonly LeadSort[] = [
  { id: "recent", label: "Newest reply first", order: "last_reply_at.desc.nullslast,created_at.desc" },
  { id: "oldest", label: "Oldest reply first", order: "last_reply_at.asc.nullslast,created_at.desc" },
  { id: "added-desc", label: "Recently added", order: "created_at.desc" },
  { id: "added-asc", label: "First added", order: "created_at.asc" },
  { id: "replies-desc", label: "Most replies", order: "reply_count.desc.nullslast,created_at.desc" },
  { id: "replies-asc", label: "Fewest replies", order: "reply_count.asc.nullslast,created_at.desc" },
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
