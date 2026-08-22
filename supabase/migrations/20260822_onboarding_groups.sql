-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Onboarding tasks are grouped under three urgency headers — Immediate, First week, Least Urgent — so the
-- checklist reads as a plan, not a flat list. The group lives on the top-level step only; sub-steps render
-- under their parent and inherit its group. Named task_group, not "group", because group is a SQL keyword.
alter table if exists rr_onboarding_template_steps add column if not exists task_group text;
alter table if exists rr_onboarding_tasks add column if not exists task_group text;

-- Backfill the existing template and every in-progress client's snapshot, by the ranked position: the early
-- steps are Immediate, the middle of the list is the first week, the integration/CRM tail is least urgent.
update rr_onboarding_template_steps set task_group = case
  when position <= 800 then 'Immediate'
  when position <= 2000 then 'First week'
  else 'Least Urgent' end
where parent_id is null and task_group is null;

update rr_onboarding_tasks set task_group = case
  when position <= 800 then 'Immediate'
  when position <= 2000 then 'First week'
  else 'Least Urgent' end
where parent_id is null and task_group is null;
