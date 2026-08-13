-- Reply Radar isolated schema.
-- Every object is prefixed rr_ so this script does not alter existing project tables.
create extension if not exists pgcrypto;

create table if not exists rr_workspaces (
  id uuid primary key default gen_random_uuid(), name text not null default '', slug text unique not null,
  heyreach_api_key_ciphertext text, webhook_secret_hash text, webhook_url text,
  anthropic_model text, client_brief text, custom_system_prompt text,
  guardrails jsonb not null default '{}'::jsonb, theme_tokens jsonb not null default '{}'::jsonb,
  custom_scoring jsonb not null default '{}'::jsonb, logo_url text, accent_color text,
  last_webhook_received_at timestamptz, last_successful_poll_at timestamptz, last_reconciled_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

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
create table if not exists rr_global_config (
  id boolean primary key default true, anthropic_api_key_ciphertext text, supabase_url text,
  supabase_service_role_key_ciphertext text, worker_service_url text, worker_config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(), check (id)
);
-- Small app-wide lists that do not earn a table each. `rr_global_config` above is NOT this: it is one
-- row with one column per setting, and code that queries it as key/value fails.
create table if not exists rr_app_config (
  key text primary key, value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists rr_profile_preferences (
  profile_id uuid primary key references rr_profiles(id) on delete cascade,
  appearance jsonb not null default '{}'::jsonb, inbox_layout jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists rr_device_preferences (
  device_key text primary key, appearance jsonb not null default '{}'::jsonb,
  inbox_layout jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);
create table if not exists rr_leads (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  external_id text, name text, title text, company text, profile_url text, raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (workspace_id, external_id)
);
create table if not exists rr_conversations (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  lead_id uuid references rr_leads(id) on delete cascade, external_id text not null, score integer not null default 0,
  tier text not null default 'nurture', score_reason text, last_message_at timestamptz,
  last_message_direction text, snoozed_until timestamptz, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), unique (workspace_id, external_id)
);
create table if not exists rr_messages (
  id uuid primary key default gen_random_uuid(), conversation_id uuid not null references rr_conversations(id) on delete cascade,
  external_id text, direction text not null, body text not null default '', sent_at timestamptz not null,
  raw_data jsonb not null default '{}'::jsonb, unique (conversation_id, external_id)
);
create table if not exists rr_scores (
  id uuid primary key default gen_random_uuid(), conversation_id uuid not null references rr_conversations(id) on delete cascade,
  score integer not null, tier text not null, reason text not null default '', intent text, suggested_action text,
  draft_reply text, prompt_version text, config_version text, created_at timestamptz not null default now()
);
create table if not exists rr_documents (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  name text not null, storage_path text not null, mime_type text, size_bytes bigint,
  created_at timestamptz not null default now()
);
create table if not exists rr_graphs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  title text not null, definition jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists rr_webhook_events (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  event_key text not null, event_type text not null, raw jsonb not null, status text not null default 'pending',
  error_text text, received_at timestamptz not null default now(), processed_at timestamptz,
  unique (workspace_id, event_key)
);
create table if not exists rr_sync_runs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid references rr_workspaces(id) on delete cascade,
  source text not null, status text not null, started_at timestamptz not null default now(), finished_at timestamptz,
  records_seen integer not null default 0, records_written integer not null default 0, error_text text
);
create table if not exists rr_audit_log (
  id uuid primary key default gen_random_uuid(), actor text, action text not null, entity_type text,
  entity_id text, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
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

create index if not exists rr_conversations_workspace_score_idx on rr_conversations(workspace_id, score desc);
create index if not exists rr_conversations_workspace_last_message_idx on rr_conversations(workspace_id, last_message_at desc);
create index if not exists rr_messages_sent_at_idx on rr_messages(sent_at desc);
create index if not exists rr_webhook_events_workspace_received_idx on rr_webhook_events(workspace_id, received_at desc);
create index if not exists rr_reports_workspace_generated_idx on rr_reports(workspace_id, generated_at desc);
create index if not exists rr_reports_generated_idx on rr_reports(generated_at desc);

create or replace function rr_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists rr_workspaces_updated_at on rr_workspaces;
create trigger rr_workspaces_updated_at before update on rr_workspaces for each row execute function rr_set_updated_at();
drop trigger if exists rr_profiles_updated_at on rr_profiles;
create trigger rr_profiles_updated_at before update on rr_profiles for each row execute function rr_set_updated_at();
drop trigger if exists rr_conversations_updated_at on rr_conversations;
create trigger rr_conversations_updated_at before update on rr_conversations for each row execute function rr_set_updated_at();

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
alter table rr_documents enable row level security;
alter table rr_graphs enable row level security;
alter table rr_webhook_events enable row level security;
alter table rr_sync_runs enable row level security;
alter table rr_audit_log enable row level security;
alter table rr_reports enable row level security;
