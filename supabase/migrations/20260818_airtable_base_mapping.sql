-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Which Airtable base is this client's project tracker. Null means nothing is written to Airtable for
-- this client; it never means "guess". See shared/airtable-link.mjs for why the guess only prefills
-- the picker, and app/lib/airtable.ts for why the base id is stored rather than the base name.
alter table if exists rr_workspaces
  add column if not exists airtable_base_id text;
