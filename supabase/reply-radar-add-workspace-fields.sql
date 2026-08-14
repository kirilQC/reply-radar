-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Safe additive migration for existing Reply Radar installs.
alter table if exists rr_workspaces add column if not exists timezone text not null default 'America/New_York';
alter table if exists rr_workspaces add column if not exists website_url text;
