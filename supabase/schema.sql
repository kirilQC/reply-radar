-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

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
  -- Which QC Brain folder this client is, when the name-based guess is wrong. See shared/brain-link.mjs.
  brain_folder text,
  -- The two Slack channels this client has: the one the team talks in, and the one the client is in.
  -- Plain columns rather than `guardrails` entries because the brief scheduler filters on them, and a
  -- channel id is configuration a teammate pastes in, not an AI guardrail. Slack ids, not names — a
  -- channel renamed in Slack keeps its id, and a name would silently stop resolving.
  slack_internal_channel_id text, slack_external_channel_id text,
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
--
-- The columns after raw_data are generated, not stored independently: they project the fields worth
-- filtering, sorting and exporting out of the JSON, and Postgres keeps them in step automatically.
-- raw_data stays authoritative and untouched, which matters because ingestion merge-spreads it to
-- preserve cached drafts, sentiment and enrichment across syncs. PostgREST exposes generated columns
-- read-only, so no existing write can collide with them.
--
-- Timestamps are deliberately absent here: casting text to timestamptz depends on the session
-- timezone, so it is not immutable and cannot appear in a generated column. rr_leads_export below
-- carries those instead.
create table if not exists rr_leads (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  linkedin_profile_url text, linkedin_id text, name text, role text, company text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  icp_score integer generated always as ((raw_data->'reply_radar'->>'icp_score')::integer) stored,
  icp_reason text generated always as (raw_data->'reply_radar'->>'icp_reason') stored,
  ai_title text generated always as (raw_data->'reply_radar'->'ai_ark'->>'title') stored,
  ai_company text generated always as (raw_data->'reply_radar'->'ai_ark'->'company'->'summary'->>'name') stored,
  enrichment_status text generated always as (raw_data->'reply_radar'->>'enrichment_status') stored,
  enrichment_error text generated always as (raw_data->'reply_radar'->>'enrichment_error') stored,
  history_status text generated always as (raw_data->'reply_radar'->>'history_status') stored,
  client_names text generated always as (raw_data->'reply_radar'->'rollup'->>'client_names') stored,
  campaign_names text generated always as (raw_data->'reply_radar'->'rollup'->>'campaign_names') stored,
  sender_names text generated always as (raw_data->'reply_radar'->'rollup'->>'sender_names') stored,
  client_count integer generated always as ((raw_data->'reply_radar'->'rollup'->>'client_count')::integer) stored,
  campaign_count integer generated always as ((raw_data->'reply_radar'->'rollup'->>'campaign_count')::integer) stored,
  conversation_count integer generated always as ((raw_data->'reply_radar'->'rollup'->>'conversation_count')::integer) stored
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

-- Bug reports and ideas from the team. `submitted_by` is null when the reporter chose to stay
-- anonymous, which is the default; nothing else on the row identifies them.
create table if not exists rr_feedback (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'other' check (kind in ('bug', 'idea', 'other')),
  message text not null,
  submitted_by text,
  page text,
  status text not null default 'new' check (status in ('new', 'viewed', 'working', 'fixed')),
  -- The attached screenshot, inline as a data URL. The browser downscales before it uploads, so
  -- this is a few hundred kilobytes rather than a raw capture, and no storage bucket is needed.
  screenshot text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The history of a report: every status move and every comment, each signed. `status` is null on
-- an update that commented without moving the report along. Deleting the report takes its log
-- with it, since a log about nothing is not a record of anything.
create table if not exists rr_feedback_events (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references rr_feedback(id) on delete cascade,
  author text not null,
  comment text,
  status text check (status in ('new', 'viewed', 'working', 'fixed')),
  created_at timestamptz not null default now()
);

-- ── Analytics, collected by the worker rather than asked for on page load ────────────────────────
--
-- Everything the per-client analytics page shows used to be fetched from HeyReach inside the request
-- that rendered it: a campaign list, a stats rollup, and one call per sender, per client, every time
-- anybody opened the page. That is two to three seconds of somebody else's API before the first
-- number can be painted, which is why the page arrived as an empty shell and filled in later.
--
-- These two tables are the worker's copy of the same answers. The page reads Supabase and nothing
-- else, so it paints in one round trip, and the freshness is stated on screen from `refreshed_at`
-- rather than implied.

-- One row per campaign, overwritten in place each pass. The rollup HeyReach returns per campaign is
-- lifetime, so this is a current picture rather than a history — `rr_daily_stats` is the history.
create table if not exists rr_campaign_stats (
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  campaign_id text not null,
  name text not null default '',
  status text,
  launched_at timestamptz,
  -- The sender accounts assigned to the campaign. Its length times the per-sender daily cap is how
  -- many connection requests the campaign can send in a day, which is what "days left" divides by.
  sender_ids text[] not null default '{}',
  total_leads integer not null default 0,
  -- Leads that have not been contacted yet. This, not `total_leads`, is the work remaining.
  leads_pending integer not null default 0,
  leads_in_progress integer not null default 0,
  leads_finished integer not null default 0,
  connections_sent integer not null default 0,
  connections_accepted integer not null default 0,
  replies integer not null default 0,
  messages_started integer not null default 0,
  -- The campaign's own copy: the note on the connection request, and the first message after it is
  -- accepted. Held here so "which messaging performed best" can put the words next to the rates
  -- instead of next to a campaign name that only means something to whoever wrote it.
  first_touch text,
  follow_up text,
  sequence_steps integer,
  -- Null until the sequence has been read. The worker fills a handful of these per pass, so a client
  -- with sixty campaigns backfills over an hour or so rather than in one burst of sixty API calls.
  sequence_fetched_at timestamptz,
  refreshed_at timestamptz not null default now(),
  primary key (workspace_id, campaign_id)
);

-- One row per client per day per sender, plus one row per client per day for the client as a whole.
--
-- The all-senders row is what `sender_id = ''` means, and it is not redundant with the sum of the
-- others. Per-sender rows can only be written for senders HeyReach still lists; a LinkedIn account
-- disconnected next month would silently subtract itself from every day it ever sent on. The total
-- is asked for separately and stored separately so the headline chart cannot drift from HeyReach's
-- own dashboard, which is the number anyone would check it against.
create table if not exists rr_daily_stats (
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  day date not null,
  sender_id text not null default '',
  sender_name text not null default '',
  connections_sent integer not null default 0,
  connections_accepted integer not null default 0,
  messages_sent integer not null default 0,
  replies integer not null default 0,
  -- The sender's own connection-request cap, as HeyReach reports it — 25 on every account measured.
  -- Stored per row so a chart can draw the ceiling a sender was actually working to on that day.
  daily_limit integer,
  refreshed_at timestamptz not null default now(),
  primary key (workspace_id, day, sender_id)
);

-- One row per brief that was written, whether it reached Slack or not.
--
-- Not `rr_sync_runs`, which is swept at 48 hours: the whole value of a project-management brief is
-- that it can say "this has slipped three weeks running", and a two-day memory cannot. The rendered
-- text is kept as well as the outcome, so the Slack tab can show what was actually said rather than
-- only that something was, and so a brief can be re-read without spending a model call to rebuild it.
create table if not exists rr_slack_briefs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references rr_workspaces(id) on delete cascade,
  -- Which automation wrote it. One column now, because "morning brief" is the only card on the tab,
  -- but the table is the log for all of them and a second automation should not need a second table.
  automation text not null default 'morning_brief',
  -- 'preview' when nobody but the operator saw it, 'test' for the nominated test channel, 'internal'
  -- or 'external' once it is going to the client's own channels. The distinction is the audit trail
  -- for the one mistake that matters here, which is a half-tuned brief reaching a client.
  destination text not null default 'preview',
  slack_channel_id text,
  -- Slack's own message timestamp, which is also its id. Null when nothing was posted.
  slack_message_ts text,
  body text not null default '',
  -- The deterministic figures the model was given, kept so a wrong brief can be told apart from
  -- wrong inputs without re-running anything.
  signals jsonb not null default '{}'::jsonb,
  status text not null default 'success',
  error_text text,
  created_at timestamptz not null default now()
);

create index if not exists rr_workspaces_created_idx on rr_workspaces(created_at);
create index if not exists rr_profile_workspaces_workspace_idx on rr_profile_workspaces(workspace_id);
-- rr_leads is filtered by workspace and by profile URL on every ingestion pass.
create index if not exists rr_leads_workspace_idx on rr_leads(workspace_id);
create index if not exists rr_leads_profile_url_idx on rr_leads(linkedin_profile_url);
create index if not exists rr_leads_icp_score_idx on rr_leads(icp_score desc);
create index if not exists rr_conversations_workspace_tier_idx on rr_conversations(workspace_id, tier);
-- Both the rr_lead_index rollup and the lead database's `lead_id=in.(...)` read group by this column.
create index if not exists rr_conversations_lead_idx on rr_conversations(lead_id);
create index if not exists rr_conversations_last_message_idx on rr_conversations(last_message_at desc);
create index if not exists rr_messages_sent_at_idx on rr_messages(sent_at desc);
create index if not exists rr_blocked_leads_blocked_at_idx on rr_blocked_leads(blocked_at desc);
create index if not exists rr_webhook_events_received_idx on rr_webhook_events(received_at desc);
create index if not exists rr_sync_runs_started_idx on rr_sync_runs(started_at desc);
-- The heartbeat reads are all `source=eq.X&run_type=eq.Y order by started_at desc limit N`, which
-- the started_at-only index above cannot serve without scanning tens of thousands of rows.
create index if not exists rr_sync_runs_source_type_started_idx on rr_sync_runs(source, run_type, started_at desc);
-- The client analytics page reads this table on every poll to decide whether a collection is in flight,
-- and it asks by workspace rather than by source. Without this it is a scan of two days of worker log
-- every two minutes per open tab.
create index if not exists rr_sync_runs_workspace_type_started_idx on rr_sync_runs(workspace_id, run_type, started_at desc);
create index if not exists rr_audit_log_created_idx on rr_audit_log(created_at desc);
create index if not exists rr_reports_workspace_generated_idx on rr_reports(workspace_id, generated_at desc);
create index if not exists rr_reports_generated_idx on rr_reports(generated_at desc);
create index if not exists rr_feedback_status_created_idx on rr_feedback(status, created_at desc);
create index if not exists rr_feedback_events_feedback_idx on rr_feedback_events(feedback_id, created_at);
-- Both analytics tables are read one client at a time and written by the worker as a whole client at
-- a time, so the workspace is the leading column on each.
create index if not exists rr_campaign_stats_workspace_idx on rr_campaign_stats(workspace_id, launched_at desc);
-- The worker picks the client whose analytics are stalest by this column.
create index if not exists rr_campaign_stats_refreshed_idx on rr_campaign_stats(refreshed_at asc);
create index if not exists rr_daily_stats_workspace_day_idx on rr_daily_stats(workspace_id, day desc);
-- The Slack tab asks "when did this client last get a brief" once per client per open page.
create index if not exists rr_slack_briefs_workspace_created_idx on rr_slack_briefs(workspace_id, automation, created_at desc);

create or replace function rr_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists rr_workspaces_updated_at on rr_workspaces;
create trigger rr_workspaces_updated_at before update on rr_workspaces for each row execute function rr_set_updated_at();
drop trigger if exists rr_profiles_updated_at on rr_profiles;
create trigger rr_profiles_updated_at before update on rr_profiles for each row execute function rr_set_updated_at();
drop trigger if exists rr_conversations_updated_at on rr_conversations;
create trigger rr_conversations_updated_at before update on rr_conversations for each row execute function rr_set_updated_at();
drop trigger if exists rr_feedback_updated_at on rr_feedback;
create trigger rr_feedback_updated_at before update on rr_feedback for each row execute function rr_set_updated_at();

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
alter table rr_feedback enable row level security;
alter table rr_feedback_events enable row level security;
alter table rr_campaign_stats enable row level security;
alter table rr_daily_stats enable row level security;

-- A readable flattening of rr_leads for exports and ad-hoc queries: the client resolved to a name
-- rather than a UUID, and the timestamps that generated columns cannot hold.
--
-- security_invoker is load-bearing. A view in `public` runs as its owner by default, which would let
-- the anon key read straight through the row level security on the tables underneath it. Any view
-- added here needs the same treatment.
create or replace view rr_leads_export with (security_invoker = true) as
select
  w.name                                                          as client,
  l.name, l.role, l.company,
  l.ai_title, l.ai_company,
  l.icp_score, l.icp_reason,
  l.campaign_names, l.sender_names, l.client_names,
  l.client_count, l.campaign_count, l.conversation_count,
  l.enrichment_status, l.enrichment_error, l.history_status,
  (l.raw_data->'reply_radar'->>'icp_scored_at')::timestamptz      as icp_scored_at,
  (l.raw_data->'reply_radar'->>'history_fetched_at')::timestamptz as history_fetched_at,
  l.linkedin_profile_url, l.linkedin_id, l.created_at, l.id
from rr_leads l
left join rr_workspaces w on w.id = l.workspace_id;
revoke all on rr_leads_export from anon, authenticated;

-- rr_leads plus the two facts the lead database displays but rr_leads cannot hold.
--
-- The table's "Date and time" column has always shown the last reply, and its "Replies" column the
-- count of inbound messages. Both live on rr_conversations/rr_messages, so ordering rr_leads by
-- created_at produced a column of dates in no visible order — the sort was real, it just was not the
-- sort the reader could see. Joining them here makes them ordinary columns to `order=`, which is what
-- lets the sort agree with the screen.
--
-- Cheap because it is per lead, not per message: one grouped pass keyed by lead_id, served by
-- rr_conversations_lead_idx and the (conversation_id, heyreach_message_id) unique index below.
create or replace view rr_lead_index with (security_invoker = true) as
select
  l.*,
  activity.last_reply_at,
  coalesce(activity.reply_count, 0) as reply_count
from rr_leads l
left join (
  select c.lead_id,
         max(c.last_message_at)                                  as last_reply_at,
         count(m.id) filter (where m.direction = 'inbound')       as reply_count
  from rr_conversations c
  left join rr_messages m on m.conversation_id = c.id
  group by c.lead_id
) activity on activity.lead_id = l.id;
revoke all on rr_lead_index from anon, authenticated;

-- Retention for the worker's log: 48 hours, matching what the Render worker enforces hourly in
-- `pruneSyncRuns`. The worker is what actually runs — this function is kept so the policy is stated
-- in the schema and can be run by hand, and because the pg_cron line below was only ever a comment,
-- which is how the table reached ninety thousand rows.
--   select cron.schedule('rr-prune-sync-runs', '17 * * * *', 'select public.rr_prune_sync_runs()');
--
-- AI Ark rows are held for a fortnight rather than two days. They are one per lead enrichment instead
-- of seventeen per poll cycle, so they are not the volume problem, and the health page draws a
-- fourteen-day enrichment usage chart from them.
create or replace function rr_prune_sync_runs() returns void language sql as $$
  delete from public.rr_sync_runs where coalesce(source, '') <> 'ai_ark' and started_at < now() - interval '48 hours';
  delete from public.rr_sync_runs where source = 'ai_ark' and started_at < now() - interval '14 days';
$$;
