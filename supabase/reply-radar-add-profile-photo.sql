-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Additive migration for existing Reply Radar installations.
-- Safe to run alongside unrelated tables and projects.
alter table if exists public.rr_profiles
  add column if not exists avatar_url text;

notify pgrst, 'reload schema';
