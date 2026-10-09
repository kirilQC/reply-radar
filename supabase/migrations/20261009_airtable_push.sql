-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Airtable as a push destination: provider 'airtable', one row per connected table, kind 'airtable:<id>'.
alter table rr_crm_push drop constraint if exists rr_crm_push_provider_check;
alter table rr_crm_push add constraint rr_crm_push_provider_check
  check (provider in ('hubspot', 'attio', 'google_sheets', 'airtable'));
alter table rr_crm_push drop constraint if exists rr_crm_push_kind_check;
alter table rr_crm_push add constraint rr_crm_push_kind_check
  check (kind = 'crm' or kind = 'sheets' or kind like 'sheets:%' or kind like 'airtable:%');
