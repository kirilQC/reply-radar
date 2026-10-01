-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Inbox tags.
--
-- Tag DEFINITIONS (name + colour) are a tiny shared vocabulary, so they live as one row in rr_app_config
-- under the key "inbox_tags" rather than earning their own table — same call the scoring templates make.
-- Tag ASSIGNMENTS grow with the inbox and are shared by the whole team (a reply tagged "DQ" is DQ for
-- everyone), so they are a real table here, keyed at conversation grain to match the id the inbox selects on.

create table if not exists rr_inbox_tag_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  conversation_id uuid not null references rr_conversations(id) on delete cascade,
  tag_id text not null,
  created_at timestamptz not null default now(),
  unique (conversation_id, tag_id)
);

create index if not exists rr_inbox_tag_assignments_conversation_idx on rr_inbox_tag_assignments (conversation_id);
create index if not exists rr_inbox_tag_assignments_tag_idx on rr_inbox_tag_assignments (tag_id);

alter table rr_inbox_tag_assignments enable row level security;
