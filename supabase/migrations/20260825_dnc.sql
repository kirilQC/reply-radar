-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- The do-not-contact (DNC) list: companies a client never wants QC to reach out to. This is Reply Radar's own
-- mirror (the bot reads it back instantly); the client-facing copy lives in the client's Clay table, written
-- through that table's webhook source. Dedupe is on (workspace_id, key) where key is the domain when known,
-- else a normalized company name — so re-adding a company just refreshes its row.
create table if not exists rr_dnc (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  -- The client's name, denormalized so the table is readable at a glance without joining on workspace_id.
  client text,
  company text not null,
  domain text,
  key text not null,
  reason text,
  added_by text,
  source text not null default 'manual',
  clay_synced boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, key)
);
create index if not exists rr_dnc_workspace_idx on rr_dnc(workspace_id);

-- Where each client's Clay DNC table receives rows: the webhook URL from that table's "Import from Webhook"
-- source. No Clay API key is involved, and it works whether or not Clay Audiences is enabled.
alter table rr_workspaces add column if not exists clay_dnc_webhook_url text;
