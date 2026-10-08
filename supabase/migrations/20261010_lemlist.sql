-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- lemlist as a third reply source (app/lib/lemlist.ts, app/lib/lemlist-ingest.ts). One lemlist API key per
-- client (a key is one lemlist team), the team it belongs to, QC's two reply webhooks in that team, the secret
-- in their URLs, and the last sync. Conversations are keyed `lemlist:<contact id>:<email|linkedin>`.
alter table rr_workspaces add column if not exists lemlist_api_key text;
alter table rr_workspaces add column if not exists lemlist_team_id text;
alter table rr_workspaces add column if not exists lemlist_team_name text;
alter table rr_workspaces add column if not exists lemlist_webhook_ids text[];
alter table rr_workspaces add column if not exists lemlist_webhook_secret text;
alter table rr_workspaces add column if not exists lemlist_synced_at timestamptz;
notify pgrst, 'reload schema';
