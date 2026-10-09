-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- A client can push into as many Google Sheets as they like: each sheet is its own rr_crm_push row with
-- kind 'sheets:<id>' (the first one keeps kind 'sheets').
alter table rr_crm_push drop constraint if exists rr_crm_push_kind_check;
alter table rr_crm_push add constraint rr_crm_push_kind_check
  check (kind = 'crm' or kind = 'sheets' or kind like 'sheets:%');
notify pgrst, 'reload schema';
