-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Booking alerts: QC Command catches a Calendly / cal.com booking, enriches it through the shared Clay table,
-- then runs the client's steps (Slack card + threads, HubSpot deal, extra webhooks). Replaces the per-client
-- Zaps. The I/O is in app/lib/booking-run.ts, the pure parsing and layout in shared/bookings.mjs.
--
-- Per client: booking_config holds { enabled, enabled_at, event_filter, channel, steps: [...] } so a new step
-- type never needs a migration. The client's own Calendly token / cal.com secret (only when they book on their
-- own calendar rather than QC's) sit in their own columns so the settings API can mask them.
alter table rr_workspaces add column if not exists booking_config jsonb not null default '{}'::jsonb;
alter table rr_workspaces add column if not exists calendly_token text;
alter table rr_workspaces add column if not exists calendly_subscription jsonb;
alter table rr_workspaces add column if not exists calcom_secret text;

-- Per meeting: where it is in the pipeline (Clay sent / received, each step's result, the TLDR).
alter table rr_meetings add column if not exists booking jsonb not null default '{}'::jsonb;
create index if not exists rr_meetings_booking_stage_idx on rr_meetings ((booking->>'stage'));

notify pgrst, 'reload schema';
