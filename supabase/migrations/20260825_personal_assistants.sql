-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- The personal assistant: per-person morning briefs. One row per team member — their name, the Slack user id
-- to DM, the clients they track, and their own schedule (same days/hour/timezone model as the client briefs).
create table if not exists rr_slack_personal_assistants (
  id uuid primary key default gen_random_uuid(),
  person_name text not null,
  slack_user_id text,
  client_slugs text[] not null default '{}',
  enabled boolean not null default false,
  send_days integer[] not null default '{1,2,3,4,5}',
  send_hour integer not null default 8,
  send_minute integer not null default 0,
  timezone text not null default 'America/New_York',
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
