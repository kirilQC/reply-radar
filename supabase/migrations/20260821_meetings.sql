-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Booked meetings per client. The main source is a Zapier webhook off each client's Calendly (routed by the
-- client name in the payload); meetings can also be added by hand, or by the assistant when it spots one in a
-- reply or a Slack channel. I/O in app/lib/meetings.ts, the flexible payload mapping in shared/meetings.mjs.
create table if not exists rr_meetings (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references rr_workspaces(id) on delete cascade,
  -- The person who booked.
  invitee_name        text,
  invitee_email       text,
  invitee_linkedin    text,
  invitee_title       text,
  invitee_location    text,
  invitee_headline    text,
  -- Their company, as enriched.
  company_name        text,
  company_domain      text,
  company_linkedin    text,
  company_location    text,
  company_industry    text,
  company_size        text,
  company_type        text,
  company_description text,
  -- The meeting itself.
  meeting_at          timestamptz,  -- the parsed start time, when the payload carried a parseable one
  when_text           text,         -- the start time exactly as sent, kept so it still shows if unparseable
  summary             text,         -- the event type, e.g. "Steadywell Intro"
  host                text,         -- who the meeting is with on our side, e.g. "Josh & Tim"
  campaign            text,         -- the campaign it came from, e.g. "SW015: Social Signals (Batch 5)"
  status              text not null default 'scheduled', -- scheduled | rescheduled | canceled | completed | no_show
  source              text not null default 'manual',    -- webhook | manual | slack | reply | qc_bot
  external_id         text,         -- the Calendly event id, so a reschedule updates the row instead of adding one
  raw                 jsonb not null default '{}'::jsonb, -- the whole payload, so nothing sent is ever lost
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists rr_meetings_workspace_idx on rr_meetings(workspace_id);
create index if not exists rr_meetings_at_idx on rr_meetings(meeting_at);
-- One row per Calendly event per client: what lets a reschedule update rather than duplicate. NOT a partial
-- index: PostgREST's on_conflict=workspace_id,external_id needs a matching index with no WHERE predicate to use
-- as the upsert arbiter — a partial one raises 42P10 and every webhook carrying an event id fails to save.
-- Postgres already treats NULL external_ids as distinct, so manual meetings (no event id) still coexist freely.
drop index if exists rr_meetings_external_idx;
create unique index if not exists rr_meetings_external_idx on rr_meetings(workspace_id, external_id);

drop trigger if exists rr_meetings_updated_at on rr_meetings;
create trigger rr_meetings_updated_at before update on rr_meetings for each row execute function rr_set_updated_at();

alter table rr_meetings enable row level security;
