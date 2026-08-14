-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Reply Radar: permanent storage for generated client reports.
--
-- Safe to run more than once. Written additively (create if not exists / add column if not exists)
-- because the production schema has drifted from schema.sql before, so this must not assume the table
-- is absent or that an earlier version of it matches.

create table if not exists rr_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references rr_workspaces(id) on delete set null,
  workspace_name text not null default 'All clients',
  template_id text not null,
  template_name text not null,
  title text not null,
  period text not null,
  period_label text not null,
  sections jsonb not null default '[]'::jsonb,
  message_channel text,
  message_text text,
  csv_text text,
  data jsonb not null default '{}'::jsonb,
  page_estimate integer,
  generated_by text,
  generated_at timestamptz not null default now()
);

-- Bring an earlier version of the table up to date, if one already exists.
alter table if exists rr_reports add column if not exists workspace_name text;
alter table if exists rr_reports add column if not exists template_id text;
alter table if exists rr_reports add column if not exists template_name text;
alter table if exists rr_reports add column if not exists title text;
alter table if exists rr_reports add column if not exists period text;
alter table if exists rr_reports add column if not exists period_label text;
alter table if exists rr_reports add column if not exists sections jsonb;
alter table if exists rr_reports add column if not exists message_channel text;
alter table if exists rr_reports add column if not exists message_text text;
alter table if exists rr_reports add column if not exists csv_text text;
alter table if exists rr_reports add column if not exists data jsonb;
alter table if exists rr_reports add column if not exists page_estimate integer;
alter table if exists rr_reports add column if not exists generated_by text;
alter table if exists rr_reports add column if not exists generated_at timestamptz;

update rr_reports set workspace_name = coalesce(workspace_name, 'All clients') where workspace_name is null;
update rr_reports set sections = coalesce(sections, '[]'::jsonb) where sections is null;
update rr_reports set data = coalesce(data, '{}'::jsonb) where data is null;
update rr_reports set generated_at = coalesce(generated_at, now()) where generated_at is null;

alter table rr_reports alter column workspace_name set default 'All clients';
alter table rr_reports alter column sections set default '[]'::jsonb;
alter table rr_reports alter column data set default '{}'::jsonb;
alter table rr_reports alter column generated_at set default now();

create index if not exists rr_reports_workspace_generated_idx on rr_reports(workspace_id, generated_at desc);
create index if not exists rr_reports_generated_idx on rr_reports(generated_at desc);

alter table rr_reports enable row level security;
