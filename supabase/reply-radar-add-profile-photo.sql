-- Additive migration for existing Reply Radar installations.
-- Safe to run alongside unrelated tables and projects.
alter table if exists public.rr_profiles
  add column if not exists avatar_url text;

notify pgrst, 'reload schema';
