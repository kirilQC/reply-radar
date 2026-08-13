-- Reply Radar isolated schema.
-- Every object is prefixed rr_ so this script does not alter existing project tables.
--
-- RECONCILED 2026-08-13 against a live introspection of the production database.
--
-- This file had drifted badly: it still described the pre-HeyReach naming (`external_id` instead of
-- `heyreach_conversation_id` / `heyreach_message_id` / `linkedin_id`), the pre-rewrite audit shape
-- (`action`/`entity_type` instead of `event_type`/`actor_type`), and three indexes that do not exist,
-- while omitting `rr_blocked_leads` entirely. Running the old version on a fresh project produced a
-- database the application could not talk to. Everything below now matches production column for
-- column; the application follows the database, so the database is the source of truth here.
create extension if not exists pgcrypto;

create table if not exists rr_workspaces (
  id uuid primary key default gen_random_uuid(), name text not null default '', slug text unique not null,
  heyreach_api_key_ciphertext text, webhook_secret_hash text, webhook_url text,
  anthropic_model text, client_brief text, custom_system_prompt text,
  guardrails jsonb not null default '{}'::jsonb, theme_tokens jsonb not null default '{}'::jsonb,
  custom_scoring jsonb not null default '{}'::jsonb, logo_url text, accent_color text,
  timezone text not null default 'America/New_York', website_url text,
  last_webhook_received_at timestamptz, last_successful_poll_at timestamptz, last_reconciled_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- avatar_url holds the teammate photo, stored as a base64 data URL (the uploader is a client-side
-- FileReader, so there is no object storage in the path). That is why this table is measured in
-- megabytes for a dozen rows.
create table if not exists rr_profiles (
  id uuid primary key default gen_random_uuid(), name text not null default '', avatar_url text,
  title text, linkedin_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists rr_profile_workspaces (
  profile_id uuid not null references rr_profiles(id) on delete cascade,
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  created_at timestamptz not null default now(), primary key (profile_id, workspace_id)
);

-- One row per setting, not key/value. Code that queries this table with `?key=eq.x` fails with
-- "column rr_global_config.key does not exist" — that is what `rr_app_config` below is for.
create table if not exists rr_global_config (
  id boolean primary key default true, anthropic_model text, worker_service_url text,
  poll_interval_seconds integer, max_retries integer, queue_mode text,
  updated_at timestamptz not null default now(), check (id)
);
-- Small app-wide lists that do not earn a table each: scoring templates, report templates, AI
-- config. This is the key/value store; `rr_global_config` above is not.
create table if not exists rr_app_config (
  key text primary key, value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
-- Preferences are keyed by browser (the `rr-device` cookie), not by profile: two teammates sharing
-- one client inbox need independent appearance and layout. `rr_profile_preferences` is the earlier
-- per-profile design and is no longer written.
create table if not exists rr_profile_preferences (
  profile_id uuid primary key references rr_profiles(id) on delete cascade,
  appearance jsonb not null default '{}'::jsonb, inbox_layout jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists rr_device_preferences (
  device_key text primary key, appearance jsonb not null default '{}'::jsonb,
  inbox_layout jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- raw_data carries the whole HeyReach lead payload plus the `reply_radar` attribution block
-- (campaign, sender, AI Ark enrichment), which is where the size of this table comes from.
create table if not exists rr_leads (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  linkedin_profile_url text, linkedin_id text, name text, role text, company text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- last_refreshed_at is what lets the inbox skip re-syncing a conversation someone just synced. It
-- is stamped on every refresh attempt that reaches HeyReach, message or no message.
create table if not exists rr_conversations (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  lead_id uuid references rr_leads(id) on delete cascade,
  heyreach_conversation_id text not null, account_id text,
  score integer, tier text, score_reason text,
  last_message_at timestamptz, last_message_direction text, last_refreshed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (workspace_id, heyreach_conversation_id)
);
create table if not exists rr_messages (
  id uuid primary key default gen_random_uuid(), conversation_id uuid not null references rr_conversations(id) on delete cascade,
  heyreach_message_id text, direction text not null, body text not null default '', sent_at timestamptz not null,
  raw_data jsonb not null default '{}'::jsonb, unique (conversation_id, heyreach_message_id)
);
-- Score history. Live scores are denormalised onto rr_conversations; this table is only read by
-- lead deletion, and tolerates being absent.
create table if not exists rr_scores (
  id uuid primary key default gen_random_uuid(), conversation_id uuid not null references rr_conversations(id) on delete cascade,
  score integer, tier text, reason text, intent text, suggested_action text,
  draft_reply text, prompt_version text, config_version text, created_at timestamptz not null default now()
);
-- Leads excluded from every inbox. Keyed on the LinkedIn profile alone, so a block applies across
-- all clients rather than per workspace.
create table if not exists rr_blocked_leads (
  profile_key text primary key, name text, reason text,
  blocked_at timestamptz not null default now()
);
create table if not exists rr_documents (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  file_name text not null, storage_path text not null, mime_type text, file_size bigint,
  uploaded_at timestamptz not null default now()
);
create table if not exists rr_graphs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  title text not null default '', metric_key text not null default '', visualization text not null default '',
  position integer not null default 0, config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists rr_webhook_events (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  event_key text not null, event_type text not null, raw jsonb not null, status text not null default 'pending',
  error_text text, received_at timestamptz not null default now(), processed_at timestamptz,
  unique (workspace_id, event_key)
);
-- The worker's heartbeat and poll log. High volume by design — one row a minute for the liveness
-- touch plus two per poll cycle — and only ever read back with a small limit, so it needs a
-- retention policy rather than more columns. Notably there is no `metadata` column and never was.
create table if not exists rr_sync_runs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid references rr_workspaces(id) on delete cascade,
  source text default 'unknown', run_type text not null default 'sync', status text not null,
  started_at timestamptz not null default now(), finished_at timestamptz,
  records_seen integer not null default 0, records_written integer not null default 0, error_text text
);
-- actor_type/actor_id are free text ("Admin console", a profile id, "system"), which is why they are
-- not foreign keys. workspace_id and profile_id null out rather than cascading so the trail
-- survives the thing it describes.
create table if not exists rr_audit_log (
  id uuid primary key default gen_random_uuid(), event_type text not null,
  actor_type text, actor_id text,
  workspace_id uuid references rr_workspaces(id) on delete set null,
  profile_id uuid references rr_profiles(id) on delete set null,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
-- Generated client reports, kept permanently.
--
-- workspace_id is nullable on purpose: "All clients" is a valid report scope, and a report should
-- outlive the client it describes, so the reference nulls out rather than cascading. workspace_name is
-- denormalised beside it so a deleted client leaves its report history readable instead of blank.
-- data holds the exact numbers the report was rendered from, which is what makes a saved report
-- reproducible years later even after the underlying messages have been purged.
create table if not exists rr_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references rr_workspaces(id) on delete set null,
  workspace_name text not null default 'All clients',
  template_id text not null, template_name text not null, title text not null,
  period text not null, period_label text not null,
  sections jsonb not null default '[]'::jsonb,
  message_channel text, message_text text, csv_text text,
  data jsonb not null default '{}'::jsonb,
  page_estimate integer, generated_by text,
  generated_at timestamptz not null default now()
);

create index if not exists rr_workspaces_created_idx on rr_workspaces(created_at);
create index if not exists rr_profile_workspaces_workspace_idx on rr_profile_workspaces(workspace_id);
-- rr_leads is filtered by workspace and by profile URL on every ingestion pass.
create index if not exists rr_leads_workspace_idx on rr_leads(workspace_id);
create index if not exists rr_leads_profile_url_idx on rr_leads(linkedin_profile_url);
create index if not exists rr_conversations_workspace_tier_idx on rr_conversations(workspace_id, tier);
create index if not exists rr_conversations_last_message_idx on rr_conversations(last_message_at desc);
create index if not exists rr_messages_sent_at_idx on rr_messages(sent_at desc);
create index if not exists rr_blocked_leads_blocked_at_idx on rr_blocked_leads(blocked_at desc);
create index if not exists rr_webhook_events_received_idx on rr_webhook_events(received_at desc);
create index if not exists rr_sync_runs_started_idx on rr_sync_runs(started_at desc);
-- The heartbeat reads are all `source=eq.X&run_type=eq.Y order by started_at desc limit N`, which
-- the started_at-only index above cannot serve without scanning tens of thousands of rows.
create index if not exists rr_sync_runs_source_type_started_idx on rr_sync_runs(source, run_type, started_at desc);
create index if not exists rr_audit_log_created_idx on rr_audit_log(created_at desc);
create index if not exists rr_reports_workspace_generated_idx on rr_reports(workspace_id, generated_at desc);
create index if not exists rr_reports_generated_idx on rr_reports(generated_at desc);

create or replace function rr_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists rr_workspaces_updated_at on rr_workspaces;
create trigger rr_workspaces_updated_at before update on rr_workspaces for each row execute function rr_set_updated_at();
drop trigger if exists rr_profiles_updated_at on rr_profiles;
create trigger rr_profiles_updated_at before update on rr_profiles for each row execute function rr_set_updated_at();
drop trigger if exists rr_conversations_updated_at on rr_conversations;
create trigger rr_conversations_updated_at before update on rr_conversations for each row execute function rr_set_updated_at();

-- Enabled with zero policies on every table, which is deliberate: all access is server-side with the
-- service role key, which bypasses RLS. The anon key therefore reads nothing at all.
alter table rr_workspaces enable row level security;
alter table rr_profiles enable row level security;
alter table rr_profile_workspaces enable row level security;
alter table rr_global_config enable row level security;
alter table rr_app_config enable row level security;
alter table rr_profile_preferences enable row level security;
alter table rr_device_preferences enable row level security;
alter table rr_leads enable row level security;
alter table rr_conversations enable row level security;
alter table rr_messages enable row level security;
alter table rr_scores enable row level security;
alter table rr_blocked_leads enable row level security;
alter table rr_documents enable row level security;
alter table rr_graphs enable row level security;
alter table rr_webhook_events enable row level security;
alter table rr_sync_runs enable row level security;
alter table rr_audit_log enable row level security;
alter table rr_reports enable row level security;
