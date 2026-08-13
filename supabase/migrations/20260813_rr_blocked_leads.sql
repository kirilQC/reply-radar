-- Reply Radar: people we refuse to ingest.
--
-- Why this exists. Deleting an unwanted reply — the client's friend, a recruiter, someone who is not a
-- lead — worked, and then their next message arrived and ingestion built the whole person again from the
-- webhook. Same person, new row, back in the inbox, every week. There was nowhere to record the decision,
-- so the decision could not survive the next reply.
--
-- Keyed on the normalised LinkedIn profile URL, not a lead id. `rr_leads` is keyed per client and gets a
-- brand new row every time ingestion meets someone, so a lead id identifies a row that is about to be
-- replaced. The profile URL is the only thing that persists across ingestions, and it is already what
-- `app/lib/lead-deletion.ts` uses to decide that two rows are the same person. Normalisation
-- (lower-cased, no query string, no trailing slash) is done by `shared/blocklist.mjs` so the app and the
-- ingestion check cannot disagree about the key — the same normalisation ingestion already applies before
-- writing `rr_leads.linkedin_profile_url`.
--
-- `profile_key` is the primary key, which makes re-blocking someone idempotent: an upsert on conflict
-- rather than a duplicate row and an ambiguous unblock.
--
-- Safe to run more than once.

create table if not exists rr_blocked_leads (
  profile_key text primary key,
  -- Kept only so the blocked list is readable by a human deciding whether to unblock. Nothing matches on
  -- these: the row that carried them is deleted when the block is created.
  name text,
  reason text,
  blocked_at timestamptz not null default now()
);

-- Bring an earlier version of the table up to date, if one already exists.
alter table if exists rr_blocked_leads add column if not exists name text;
alter table if exists rr_blocked_leads add column if not exists reason text;
alter table if exists rr_blocked_leads add column if not exists blocked_at timestamptz;

update rr_blocked_leads set blocked_at = coalesce(blocked_at, now()) where blocked_at is null;

alter table rr_blocked_leads alter column blocked_at set default now();

-- Newest first is how the list is read, and the table is small enough that this is the only index worth
-- having beyond the primary key.
create index if not exists rr_blocked_leads_blocked_at_idx on rr_blocked_leads (blocked_at desc);

alter table rr_blocked_leads enable row level security;
