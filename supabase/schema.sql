-- Reply Radar foundation schema for Supabase Postgres.
create extension if not exists pgcrypto;

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  heyreach_api_key_ciphertext text,
  webhook_secret_hash text,
  anthropic_model text,
  client_brief text,
  custom_system_prompt text,
  guardrails jsonb not null default '{}'::jsonb,
  theme_tokens jsonb not null default '{}'::jsonb,
  last_webhook_received_at timestamptz,
  last_successful_poll_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  event_key text not null,
  event_type text not null,
  raw jsonb not null,
  status text not null default 'pending',
  error_text text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (workspace_id, event_key)
);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  linkedin_profile_url text,
  linkedin_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, linkedin_profile_url)
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  heyreach_conversation_id text not null,
  account_id text,
  score integer not null default 0,
  tier text not null default 'nurture',
  score_reason text,
  last_message_at timestamptz,
  last_message_direction text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, heyreach_conversation_id)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  heyreach_message_id text,
  direction text not null,
  body text not null,
  sent_at timestamptz not null,
  raw_data jsonb not null default '{}'::jsonb,
  unique (conversation_id, heyreach_message_id)
);

create table if not exists scores (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  score integer not null,
  tier text not null,
  reason text not null,
  intent text,
  suggested_action text,
  draft_reply text,
  prompt_version text,
  config_version text,
  created_at timestamptz not null default now()
);

create index if not exists webhook_events_workspace_received_idx on webhook_events(workspace_id, received_at desc);
create index if not exists conversations_workspace_score_idx on conversations(workspace_id, score desc);
