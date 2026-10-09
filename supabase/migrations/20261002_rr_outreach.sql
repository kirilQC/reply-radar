-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Every person QC has contacted, for every client, from HeyReach's campaign leads.
-- Filled by the Render worker (syncOutreach), one client per analytics pass, re-synced daily.
-- Read by Scout's outreach_people tool for "everyone with title X we contacted between A and B".
create table if not exists rr_outreach (
  workspace_id uuid not null,
  campaign_id text not null,
  heyreach_lead_id text not null,
  campaign_name text,
  linkedin_url text,
  full_name text,
  title text,
  company text,
  location text,
  sender_name text,
  connection_status text,
  message_status text,
  campaign_status text,
  added_at timestamptz,
  last_action_at timestamptz,
  finished_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (workspace_id, campaign_id, heyreach_lead_id)
);
create index if not exists rr_outreach_ws_action on rr_outreach (workspace_id, last_action_at desc);
create index if not exists rr_outreach_action on rr_outreach (last_action_at desc);
create index if not exists rr_outreach_title on rr_outreach (lower(title));
