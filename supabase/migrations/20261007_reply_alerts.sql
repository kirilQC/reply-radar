-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Reply alerts: each lead reply posted to the client's replies channel with a draft and a Send button.
-- Off by default. reply_alerts_enabled_at is stamped when it is switched on; older replies are never posted.
alter table rr_workspaces add column if not exists slack_replies_channel_id text;
alter table rr_workspaces add column if not exists reply_alerts_enabled boolean not null default false;
alter table rr_workspaces add column if not exists reply_alerts_enabled_at timestamptz;
notify pgrst, 'reload schema';
