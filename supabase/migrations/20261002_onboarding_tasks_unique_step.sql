-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- One checklist row per template step per client.
--
-- A client's checklist is snapshotted from the template the first time it is opened. Two people opening a
-- fresh client at the same moment both saw it empty and both snapshotted it, so the client got every step
-- twice. The app now inserts with on_conflict=workspace_id,template_step_id and ignore-duplicates, which
-- needs this index to exist; until it does, the app falls back to a plain insert.
--
-- DEDUPE FIRST. The index cannot be created while duplicates exist, so the two statements before it pick a
-- survivor for each (workspace_id, template_step_id) — a ticked row over an unticked one, then the oldest —
-- move any sub-steps hanging off a duplicate parent onto the survivor, and delete the rest. Rows added to a
-- client by hand have a null template_step_id and are untouched (nulls never collide in a unique index).
--
-- Check what will be removed before running:
--
--   select workspace_id, template_step_id, count(*)
--   from rr_onboarding_tasks
--   where template_step_id is not null
--   group by 1, 2
--   having count(*) > 1;

begin;

-- 1. Sub-steps under a duplicate parent move to that parent's survivor, so deleting the duplicate parent
--    does not cascade away sub-steps that were ticked.
with ranked as (
  select id,
         first_value(id) over (
           partition by workspace_id, template_step_id
           order by is_done desc, created_at asc, id asc
         ) as survivor
  from rr_onboarding_tasks
  where template_step_id is not null
)
update rr_onboarding_tasks t
set parent_id = r.survivor
from ranked r
where t.parent_id = r.id
  and r.id <> r.survivor;

-- 2. Delete every row that is not its group's survivor.
with ranked as (
  select id,
         first_value(id) over (
           partition by workspace_id, template_step_id
           order by is_done desc, created_at asc, id asc
         ) as survivor
  from rr_onboarding_tasks
  where template_step_id is not null
)
delete from rr_onboarding_tasks t
using ranked r
where t.id = r.id
  and r.id <> r.survivor;

-- 3. The constraint the app's on_conflict names. A full (not partial) unique index, because PostgREST's
--    on_conflict can only target an index without a predicate.
create unique index if not exists rr_onboarding_tasks_workspace_step_uidx
  on rr_onboarding_tasks (workspace_id, template_step_id);

commit;

notify pgrst, 'reload schema';
