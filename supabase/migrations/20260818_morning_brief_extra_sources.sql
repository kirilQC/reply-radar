-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

/*
 * Extra sources for a client's morning brief, on top of the three that are the point.
 *
 * ── Why these are separate columns rather than more entries in the existing ones ──────────────────
 * `granola_title_match` already takes a comma-separated list, and it would have been one character of
 * work to let it hold four names. That is exactly why it must not: those entries are alternate spellings
 * of *one* meeting — "Vitalic Health" and "Vitalic" are the same call — and the matcher treats them as
 * interchangeable. An additional weekly internal call is a different meeting with its own transcript,
 * and merging the two lists would silently make the newest of six meetings the client's "last call".
 *
 * The same reasoning applies to the channels. `slack_internal_channel_id` and
 * `slack_external_channel_id` are named for what they are because the brief reads them differently: the
 * internal channel is where our team commits to things and the external one is where the client does.
 * A third channel has no such standing, so it goes in a list that is labelled as extra all the way
 * through to the prompt.
 *
 * Arrays rather than a child table, because there is no per-entry state to keep — no enabled flag, no
 * last-read timestamp, nothing that would ever be queried on its own. A join table for two lists of
 * strings read once per brief is a table to migrate and nothing else.
 */

alter table if exists rr_workspaces
  add column if not exists granola_extra_title_matches text[] not null default '{}';

alter table if exists rr_workspaces
  add column if not exists slack_extra_channel_ids text[] not null default '{}';

comment on column rr_workspaces.granola_extra_title_matches is
  'Additional meeting-title matches, one per extra call to read. Each entry finds its own latest meeting; the primary granola_title_match still names the main weekly call.';

comment on column rr_workspaces.slack_extra_channel_ids is
  'Additional Slack channel ids to read for context. The internal and external channels remain the two that matter; these are read after them and presented to the model as extra.';
