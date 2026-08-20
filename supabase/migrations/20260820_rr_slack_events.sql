-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Reply Radar: the Slack events already answered.
--
-- Why this exists. Slack redelivers an event if it does not see a 200 within three seconds, and the QC
-- Bot answer is a thirty-round research loop that never finishes inside that window — so it is answered
-- after the 200 goes back, and Slack, seeing nothing in time, retries. A retry that reran the agent would
-- post the same answer to the same thread twice.
--
-- The insert is the lock. `event_id` is Slack's own id for a delivery and is the primary key here, so the
-- first delivery's insert succeeds (201) and claims the work, and every retry's insert is refused by the
-- primary key (409), which the route reads as "someone already has this one" and does nothing. No row is
-- ever read back; the write succeeding or failing is the whole signal.
--
-- Safe to run more than once.

create table if not exists rr_slack_events (
  event_id text primary key,
  created_at timestamptz not null default now()
);

-- The service role does the claiming; no other role should see this table.
alter table rr_slack_events enable row level security;
