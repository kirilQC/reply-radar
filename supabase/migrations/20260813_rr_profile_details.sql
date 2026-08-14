-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Teammate profiles gain the two fields the profile editor now collects: job title and LinkedIn
-- URL. Additive and re-runnable; the API tolerates their absence, so profiles keep saving
-- (minus these two fields) until this runs.
alter table if exists public.rr_profiles
  add column if not exists title text,
  add column if not exists linkedin_url text;

notify pgrst, 'reload schema';
