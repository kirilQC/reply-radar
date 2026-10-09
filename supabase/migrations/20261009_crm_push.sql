-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Pushing replies into a client's own CRM (HubSpot or Attio) or a Google Sheet, from the onboarding cockpit.
-- app/lib/crm-push.ts, app/lib/hubspot-push.ts. One destination row per client and kind; the key never leaves
-- the server. `audit` is the read-only lay of the land, `plan` the build the user approves, `build_log` every
-- id the build created.
create table if not exists rr_crm_push (
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  kind text not null check (kind in ('crm', 'sheets')),
  provider text not null check (provider in ('hubspot', 'attio', 'google_sheets')),
  api_key text,
  account_id text,
  account_name text,
  status text not null default 'connected', -- connected | audited | planned | built
  audit jsonb,
  plan jsonb,
  build_log jsonb,
  config jsonb not null default '{}'::jsonb,
  auto_push boolean not null default false,
  last_push_at timestamptz,
  last_push_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, kind)
);

-- What each pushed conversation became in the destination, so a re-push updates instead of duplicating.
create table if not exists rr_crm_push_records (
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  conversation_id uuid not null references rr_conversations(id) on delete cascade,
  provider text not null,
  contact_id text,
  company_id text,
  note_id text,
  created_contact boolean not null default false,
  pushed_hash text,
  pushed_at timestamptz not null default now(),
  error text,
  primary key (workspace_id, conversation_id, provider)
);
create index if not exists rr_crm_push_records_contact_idx on rr_crm_push_records(workspace_id, provider, contact_id);

alter table rr_crm_push enable row level security;
alter table rr_crm_push_records enable row level security;
notify pgrst, 'reload schema';
