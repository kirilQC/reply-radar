-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Booked meetings pushed into a client's CRM as deals (app/lib/hubspot-deals.ts): which meeting became which
-- deal, so a reschedule or cancel updates it instead of making another.
create table if not exists rr_crm_push_meetings (
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  meeting_id uuid not null references rr_meetings(id) on delete cascade,
  provider text not null,
  deal_id text,
  contact_id text,
  company_id text,
  note_id text,
  pushed_hash text,
  pushed_at timestamptz not null default now(),
  error text,
  primary key (workspace_id, meeting_id, provider)
);
alter table rr_crm_push_meetings enable row level security;
notify pgrst, 'reload schema';
