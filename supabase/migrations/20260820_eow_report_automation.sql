-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Reply Radar: the End-of-Week report automation.
--
-- A third Slack automation alongside the morning brief and the call analysis. It runs the built-in
-- "Tarsi's EOW Report Template" for a client — the same generate-then-compose pipeline the Reports hub
-- uses — and posts the resulting recap to the client's internal channel on a schedule (Fridays 1pm ET
-- by default). It reuses `rr_slack_automations` for the schedule and `rr_slack_briefs` for the run log,
-- so the only new state is the per-client opt-in flag below.
--
-- The flag is its own column rather than folded into one "automations on" switch for the same reason the
-- other two are separate: a client can be trusted with an EOW report before, after, or independently of
-- their morning brief and call analysis.
--
-- Safe to run more than once.

alter table if exists rr_workspaces add column if not exists eow_report_enabled boolean not null default false;

-- Seeded off by default and pointed at Friday 1pm Eastern, so the schedule row exists for the Slack hub
-- to read the moment the feature ships, but nothing posts until somebody flips the switch and opts a
-- client in. `send_days` is JavaScript's own numbering, so 5 is Friday.
insert into rr_slack_automations (automation, enabled, send_days, send_hour, send_minute, timezone, destination)
values ('eow_report', false, '{5}', 13, 0, 'America/New_York', 'internal')
on conflict (automation) do nothing;
