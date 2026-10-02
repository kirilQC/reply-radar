-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- A lease on each cold-call job, so only one runner advances it at a time. The fetch route's background loop,
-- the browser's drain loop and the worker all process jobs; without a claim they worked the same job at once,
-- inserting the same campaign members twice and paying AI Ark for the same phone lookups twice.
-- A runner claims a job by setting locked_until only where it is null or already in the past (one atomic
-- UPDATE, so exactly one racer wins) and clears it when its pass ends. The code falls back to the old
-- unclaimed behavior until this column exists.
alter table rr_cold_call_jobs add column if not exists locked_until timestamptz;

-- Suggested, NOT applied: a unique index so two concurrent inserts of the same LinkedIn profile into one
-- workspace cannot both land. Existing duplicates would make this statement fail, so dedupe first (keep one
-- row per (workspace_id, linkedin_profile_url), merging raw_data and repointing rr_conversations /
-- rr_call_logs lead_id to the survivor), check with the query below, then uncomment and run.
--
--   select workspace_id, linkedin_profile_url, count(*)
--   from rr_leads
--   where linkedin_profile_url is not null
--   group by 1, 2
--   having count(*) > 1;
--
-- create unique index if not exists rr_leads_workspace_profile_uniq
--   on rr_leads (workspace_id, linkedin_profile_url)
--   where linkedin_profile_url is not null;
