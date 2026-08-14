-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Which QC Brain folder each client workspace is.
--
-- The brain names clients by folder and Reply Radar names them by slug and display name. Those
-- agree for most clients, so the app guesses when this is null — see shared/brain-link.mjs. This
-- column is the override for the ones where the guess is wrong, and a wrong guess is invisible:
-- it would show one client's campaign figures under another client's strategy notes.
alter table if exists rr_workspaces add column if not exists brain_folder text;
