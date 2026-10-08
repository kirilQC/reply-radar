-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Email (Email Bison) as a second channel beside LinkedIn (HeyReach). An email conversation is an ordinary
-- rr_conversations row with channel = 'email', keyed `bison:<bison lead id>` in heyreach_conversation_id so
-- nothing that talks to HeyReach ever picks it up. I/O in app/lib/emailbison.ts and app/lib/email-ingest.ts.
alter table rr_conversations add column if not exists channel text not null default 'linkedin';
create index if not exists rr_conversations_channel_idx on rr_conversations(workspace_id, channel);

-- Each client's Email Bison workspace, the workspace-scoped API token QC minted for it (so reading one client
-- never switches the super-admin user's open workspace), and the secret in its webhook URL.
alter table rr_workspaces add column if not exists emailbison_workspace_id integer;
alter table rr_workspaces add column if not exists emailbison_token text;
alter table rr_workspaces add column if not exists emailbison_webhook_id text;
alter table rr_workspaces add column if not exists emailbison_webhook_secret text;
alter table rr_workspaces add column if not exists emailbison_synced_at timestamptz;

-- Email campaign totals, one row per Email Bison campaign, refreshed by the worker.
create table if not exists rr_email_campaign_stats (
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  campaign_id text not null,
  name text not null default '',
  status text,
  total_leads integer not null default 0,
  leads_contacted integer not null default 0,
  emails_sent integer not null default 0,
  unique_replies integer not null default 0,
  interested integer not null default 0,
  bounced integer not null default 0,
  unsubscribed integer not null default 0,
  unique_opens integer not null default 0,
  created_at timestamptz,
  refreshed_at timestamptz not null default now(),
  primary key (workspace_id, campaign_id)
);

-- Email activity by day for the whole client workspace (Email Bison's own daily chart).
create table if not exists rr_email_daily_stats (
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  day date not null,
  sent integer not null default 0,
  replies integer not null default 0,
  interested integer not null default 0,
  bounced integer not null default 0,
  opens integer not null default 0,
  refreshed_at timestamptz not null default now(),
  primary key (workspace_id, day)
);

alter table rr_email_campaign_stats enable row level security;
alter table rr_email_daily_stats enable row level security;
notify pgrst, 'reload schema';
