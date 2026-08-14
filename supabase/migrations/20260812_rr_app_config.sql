-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Reply Radar: a real key/value table for small app-wide lists.
--
-- Why this exists. Three routes have been written against `rr_global_config` as though it were a
-- key/value store — `select=key,value&key=eq.<name>` — but that table is a single-row settings table
-- (`id boolean primary key default true`, one column per setting) and has no `key` or `value` column.
-- Every write failed with "column rr_global_config.key does not exist"; reads failed the same way but
-- were caught and treated as "nothing saved yet", which is why saving a report template looked like the
-- only broken thing. This adds the table that code was always assuming.
--
-- `rr_global_config` is deliberately left alone. It holds real settings in real columns and nothing
-- should be bolted onto it.
--
-- Safe to run more than once.

create table if not exists rr_app_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Bring an earlier version of the table up to date, if one already exists.
alter table if exists rr_app_config add column if not exists value jsonb;
alter table if exists rr_app_config add column if not exists updated_at timestamptz;

update rr_app_config set value = coalesce(value, '{}'::jsonb) where value is null;
update rr_app_config set updated_at = coalesce(updated_at, now()) where updated_at is null;

alter table rr_app_config alter column value set default '{}'::jsonb;
alter table rr_app_config alter column updated_at set default now();

alter table rr_app_config enable row level security;
