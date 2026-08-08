-- Safe additive migration for an rr_sync_runs table created from an earlier schema.
-- These statements only add missing columns to the Reply Radar table.
alter table if exists rr_sync_runs add column if not exists source text;
alter table if exists rr_sync_runs add column if not exists started_at timestamptz;
alter table if exists rr_sync_runs add column if not exists finished_at timestamptz;
alter table if exists rr_sync_runs add column if not exists records_seen integer;
alter table if exists rr_sync_runs add column if not exists records_written integer;
alter table if exists rr_sync_runs add column if not exists error_text text;
alter table if exists rr_sync_runs add column if not exists run_type text;
alter table if exists rr_sync_runs alter column workspace_id drop not null;

update rr_sync_runs set source = coalesce(source, 'legacy') where source is null;
update rr_sync_runs set started_at = coalesce(started_at, now()) where started_at is null;
update rr_sync_runs set records_seen = coalesce(records_seen, 0) where records_seen is null;
update rr_sync_runs set records_written = coalesce(records_written, 0) where records_written is null;
update rr_sync_runs set run_type = coalesce(run_type, source, 'sync') where run_type is null;

alter table rr_sync_runs alter column source set default 'unknown';
alter table rr_sync_runs alter column started_at set default now();
alter table rr_sync_runs alter column records_seen set default 0;
alter table rr_sync_runs alter column records_written set default 0;
alter table rr_sync_runs alter column run_type set default 'sync';
