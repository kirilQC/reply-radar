-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Offboarded ("legacy") clients. Null = active. Set from Configuration; listings and automations skip a
-- client with a value here, nothing is deleted, and clearing it restores the client.
alter table rr_workspaces add column if not exists offboarded_at timestamptz;
notify pgrst, 'reload schema';
