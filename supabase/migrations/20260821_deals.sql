-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Deals pulled from each client's CRM (HubSpot or Attio), with QC's attribution attached: which of the
-- client's pipeline can be traced, by a person-unique identifier, back to someone QC contacted or booked.
-- CRM connection lives on the workspace; the deals and their attribution live in rr_deals.
-- I/O in app/lib/deals.ts and app/lib/crm/*; the certain-or-not attribution logic in shared/deal-attribution.mjs.
alter table if exists rr_workspaces add column if not exists crm_provider text;                 -- 'hubspot' | 'attio' | null
alter table if exists rr_workspaces add column if not exists crm_api_key_ciphertext text;        -- the client's CRM token
alter table if exists rr_workspaces add column if not exists crm_last_synced_at timestamptz;

create table if not exists rr_deals (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references rr_workspaces(id) on delete cascade,
  provider                text not null,               -- 'hubspot' | 'attio'
  external_id             text not null,               -- the CRM's deal id
  name                    text,
  amount                  numeric,
  currency                text,
  stage                   text,
  pipeline                text,
  status                  text not null default 'open',-- open | won | lost
  close_date              date,
  owner                   text,
  contact_name            text,
  contact_email           text,
  contact_linkedin        text,
  company_name            text,
  company_domain          text,
  -- QC's attribution: how sure we are the deal came from us, and the evidence for it.
  attribution             text not null default 'none',-- confirmed | possible | none
  attribution_reason      text,
  attribution_matched_by  text,                        -- email | linkedin | domain
  attribution_campaign    text,
  attribution_evidence    jsonb not null default '{}'::jsonb,
  raw                     jsonb not null default '{}'::jsonb,
  synced_at               timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists rr_deals_workspace_idx on rr_deals(workspace_id);
create index if not exists rr_deals_attribution_idx on rr_deals(workspace_id, attribution);
-- One row per CRM deal per client: a re-sync updates rather than duplicates.
create unique index if not exists rr_deals_external_idx on rr_deals(workspace_id, provider, external_id);

drop trigger if exists rr_deals_updated_at on rr_deals;
create trigger rr_deals_updated_at before update on rr_deals for each row execute function rr_set_updated_at();

alter table rr_deals enable row level security;
