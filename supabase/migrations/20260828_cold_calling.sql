-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Cold calling. Phone numbers land on the lead's raw_data (from AI Ark's phone finder), surfaced as a
-- generated column so the call list can select and sort on it. Call outcomes are logged per lead. And a job
-- table drives the on-demand, background "fetch every lead in a campaign and enrich them" pipeline.

-- The mobile number AI Ark returned for a lead, projected out of raw_data for easy querying.
alter table rr_leads add column if not exists phone text generated always as (raw_data->'reply_radar'->>'phone') stored;

-- The cold-call campaign a lead was pulled in for, and whether it has been enriched, projected out of raw_data
-- as real columns. Filtering the enrichment pipeline on a deeply-nested JSON path is unreliable in PostgREST;
-- these generated columns make "this campaign's not-yet-enriched leads" a plain, indexable query.
alter table rr_leads add column if not exists cold_campaign text generated always as (raw_data->'reply_radar'->'cold_call'->>'campaignId') stored;
alter table rr_leads add column if not exists cold_enriched boolean generated always as ((raw_data->'reply_radar'->'cold_call'->>'enriched')::boolean) stored;
create index if not exists rr_leads_cold_campaign_idx on rr_leads(cold_campaign);

-- One row per logged call: who called, the outcome, and their notes.
create table if not exists rr_call_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  lead_id uuid references rr_leads(id) on delete set null,
  caller text,
  result text,
  notes text,
  called_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists rr_call_logs_workspace_idx on rr_call_logs(workspace_id);
create index if not exists rr_call_logs_lead_idx on rr_call_logs(lead_id);

-- The background pipeline that pulls a campaign's full membership out of HeyReach and enriches each lead
-- (profile + ICP score + phone). One row per campaign fetch; the worker advances it a batch at a time.
create table if not exists rr_cold_call_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  campaign_id text not null,
  campaign_name text,
  list_id text,
  status text not null default 'queued',   -- queued | fetching | enriching | done | error
  total_leads integer not null default 0,
  leads_fetched integer not null default 0,
  leads_enriched integer not null default 0,
  fetch_offset integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rr_cold_call_jobs_status_idx on rr_cold_call_jobs(status);
create index if not exists rr_cold_call_jobs_workspace_idx on rr_cold_call_jobs(workspace_id);
