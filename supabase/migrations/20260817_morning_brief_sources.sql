-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Reply Radar: the three sources a morning brief reads, and the schedule that runs it.
--
-- A brief joins HeyReach figures, both Slack channels and the client's weekly call. The figures were
-- already here; this adds the other two and the switch that turns the whole thing on.
--
-- Granola keys are per teammate rather than one shared key, because a Granola key only sees the calls
-- its owner attended and nobody attends every client call. Finding one client's call means asking each
-- key in turn. Nothing reads a key back out to a browser — the route masks each one to its last four
-- characters — so the exposure is the database, exactly as it is for the HeyReach keys already here.
--
-- Safe to run more than once.

alter table if exists rr_workspaces add column if not exists morning_brief_enabled boolean not null default false;
alter table if exists rr_workspaces add column if not exists granola_domains text;
alter table if exists rr_workspaces add column if not exists slack_internal_channel_id text;
alter table if exists rr_workspaces add column if not exists slack_external_channel_id text;

create table if not exists rr_granola_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null default '',
  api_key text not null,
  last_checked_at timestamptz, last_status text, last_error text,
  created_at timestamptz not null default now()
);

alter table if exists rr_granola_keys add column if not exists last_checked_at timestamptz;
alter table if exists rr_granola_keys add column if not exists last_status text;
alter table if exists rr_granola_keys add column if not exists last_error text;

-- `send_days` uses JavaScript's own day numbering, 0 for Sunday, so the worker compares it against
-- getDay() in the configured timezone with nothing in between to be off by one about.
create table if not exists rr_slack_automations (
  automation text primary key,
  enabled boolean not null default false,
  send_days smallint[] not null default '{1,3,5}',
  send_hour smallint not null default 8,
  send_minute smallint not null default 0,
  timezone text not null default 'America/New_York',
  destination text not null default 'test',
  updated_at timestamptz not null default now()
);

-- 'test' rather than 'internal', so the first scheduled run of a freshly enabled automation lands
-- somewhere only the team is watching.
insert into rr_slack_automations (automation) values ('morning_brief') on conflict (automation) do nothing;

create table if not exists rr_slack_briefs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  automation text not null default 'morning_brief',
  destination text not null default 'preview',
  slack_channel_id text,
  slack_message_ts text,
  body text not null default '',
  signals jsonb not null default '{}'::jsonb,
  status text not null default 'success',
  error_text text,
  created_at timestamptz not null default now()
);

-- The "has this client already had a brief today" guard reads exactly this, once per client per cycle.
create index if not exists rr_slack_briefs_workspace_created_idx
  on rr_slack_briefs(workspace_id, automation, created_at desc);

alter table rr_granola_keys enable row level security;
alter table rr_slack_automations enable row level security;
alter table rr_slack_briefs enable row level security;
