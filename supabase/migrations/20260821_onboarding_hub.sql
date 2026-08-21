-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- The onboarding hub: a client directory, a per-client checklist snapshotted from an editable master
-- template, and progress that posts to the client's internal Slack channel as it fills in.
-- I/O lives in app/lib/onboarding.ts; the progress maths and Slack text in shared/onboarding.mjs.

-- 1. Onboarding state on the client row. A client added in the hub is a full rr_workspaces row from the
--    start (per the design decision — its config is filled in as the final checklist section is worked
--    through), so the status belongs on the workspace rather than a parallel table. Null means "not an
--    onboarding client": the established clients that predate this feature keep null and never surface
--    in the hub.
alter table if exists rr_workspaces add column if not exists onboarding_status text;          -- 'in_progress' | 'complete' | null
alter table if exists rr_workspaces add column if not exists onboarding_started_at timestamptz;
alter table if exists rr_workspaces add column if not exists onboarding_completed_at timestamptz;

-- 2. The editable master template — the "client template box". One row per step; a row with a parent_id
--    is a checkable sub-step. Position is a float so a reorder can drop a step between two others without
--    renumbering the rest. Editing this changes what FUTURE clients are seeded with only; an in-progress
--    client's list is a snapshot in rr_onboarding_tasks and is deliberately never touched by an edit here.
create table if not exists rr_onboarding_template_steps (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references rr_onboarding_template_steps(id) on delete cascade,
  section     text,
  title       text not null,
  description text,
  position    double precision not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists rr_onboarding_template_steps_parent_idx on rr_onboarding_template_steps(parent_id);

-- 3. The per-client checklist, copied from the template the moment a client is added. Decoupled from the
--    template on purpose (see above). template_step_id records where a row came from — provenance, and the
--    hook a future "pull in new template steps" action would use. Null on a step added to one client by hand.
create table if not exists rr_onboarding_tasks (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references rr_workspaces(id) on delete cascade,
  parent_id        uuid references rr_onboarding_tasks(id) on delete cascade,
  template_step_id uuid references rr_onboarding_template_steps(id) on delete set null,
  section          text,
  title            text not null,
  description      text,
  position         double precision not null default 0,
  is_done          boolean not null default false,
  done_at          timestamptz,
  done_by          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists rr_onboarding_tasks_workspace_idx on rr_onboarding_tasks(workspace_id);
create index if not exists rr_onboarding_tasks_parent_idx on rr_onboarding_tasks(parent_id);

-- updated_at triggers, the same rr_set_updated_at() every other table uses.
drop trigger if exists rr_onboarding_template_steps_updated_at on rr_onboarding_template_steps;
create trigger rr_onboarding_template_steps_updated_at before update on rr_onboarding_template_steps for each row execute function rr_set_updated_at();
drop trigger if exists rr_onboarding_tasks_updated_at on rr_onboarding_tasks;
create trigger rr_onboarding_tasks_updated_at before update on rr_onboarding_tasks for each row execute function rr_set_updated_at();

-- 4. Seed the default template — QC's onboarding list, ranked most→least urgent, with the nested bullets
--    as checkable sub-steps. Guarded so it only runs on an empty template: a later edit or reorder of the
--    steps must survive this migration being re-run.
do $$
begin
  if not exists (select 1 from rr_onboarding_template_steps) then
    insert into rr_onboarding_template_steps (section, title, description, position) values
      ('Contract & kickoff',           'Client signs contract',                       null, 100),
      ('Data & tooling',               'Purchase & warm up sending emails',           'Longest lead time — start day one. Warmup runs for weeks before the inboxes can send.', 200),
      ('Contract & kickoff',           'Send kickoff email',                          null, 300),
      ('Contract & kickoff',           'Book kickoff call',                           null, 400),
      ('Communication',                'Create internal Slack channel',               null, 500),
      ('Communication',                'Create external Slack channel',               null, 600),
      ('Communication',                'Add external Slack channel canvas',           null, 700),
      ('Communication',                'Add campaign approval bot to channels',       null, 800),
      ('Data & tooling',               'Create client Airtable base',                 null, 900),
      ('Data & tooling',               'Create client folder in repo',                null, 1000),
      ('Data & tooling',               'Send onboarding form to Luke',                null, 1100),
      ('Client access & integrations', 'Ask client for Calendly access',              null, 1200),
      ('Client access & integrations', 'Ask client for DNC',                          'Compliance — the list has to be scrubbed against this before anything sends.', 1300),
      ('Client access & integrations', 'Ask client for CRM access',                   null, 1400),
      ('Data & tooling',               'Create HeyReach workspace',                   null, 1500),
      ('Data & tooling',               'Create messaging doc',                        null, 1600),
      ('Data & tooling',               'Create Spark Dashboard',                      null, 1700),
      ('Communication',                'Create replies channel',                      null, 1800),
      ('Communication',                'Add important links to internal channel',     null, 1900),
      ('Client access & integrations', 'Set up Calendly link',                        null, 2000),
      ('Client access & integrations', 'Set up booked-meeting flow',                  null, 2100),
      ('Client access & integrations', 'Hook up HeyReach replies to CRM',             null, 2200),
      ('Client access & integrations', 'Hook up EmailBison replies to CRM',           null, 2300),
      ('Client access & integrations', 'Hook up booked meetings to CRM',              null, 2400),
      ('Client access & integrations', 'Hook up AI reply bot to replies channel',     null, 2500),
      ('Client access & integrations', 'Schedule ops call with client',               null, 2600),
      ('Reply Radar setup',            'Set up client in Reply Radar',                null, 2700);

    insert into rr_onboarding_template_steps (parent_id, section, title, description, position)
    select p.id, p.section, v.title, v.description::text, v.position
    from (values
      ('Add campaign approval bot to channels',    'Add to internal channel',                    null, 10),
      ('Add campaign approval bot to channels',    'Add to external channel',                    null, 20),
      ('Create client folder in repo',             'Run /new-client-setup',                      null, 10),
      ('Create client folder in repo',             'Run /account-research',                      null, 20),
      ('Create client folder in repo',             'Drop onboarding responses in the folder',    null, 30),
      ('Create client folder in repo',             'Drop kickoff call transcript in the folder', null, 40),
      ('Add important links to internal channel',  'Messaging Doc link',                         null, 10),
      ('Add important links to internal channel',  'Airtable link',                              null, 20),
      ('Add important links to internal channel',  'Clay DNC table',                             null, 30),
      ('Add important links to internal channel',  'Calendly URL',                               null, 40),
      ('Add important links to internal channel',  'Weekly agenda doc',                          null, 50),
      ('Hook up AI reply bot to replies channel',  'Build the N8N flow',                         null, 10),
      ('Set up client in Reply Radar',             'Add workspace',                              null, 10),
      ('Set up client in Reply Radar',             'Add client logo',                            null, 20),
      ('Set up client in Reply Radar',             'Connect HeyReach API key',                   null, 30),
      ('Set up client in Reply Radar',             'Verify the Airtable connection',             null, 40),
      ('Set up client in Reply Radar',             'Verify the Granola connection',              null, 50),
      ('Set up client in Reply Radar',             'Add internal Slack channel ID',              null, 60),
      ('Set up client in Reply Radar',             'Add external Slack channel ID',              null, 70),
      ('Set up client in Reply Radar',             'Add master messaging doc URL',               null, 80),
      ('Set up client in Reply Radar',             'Add HeyReach webhook for incoming replies',  null, 90)
    ) as v(parent_title, title, description, position)
    join rr_onboarding_template_steps p on p.title = v.parent_title and p.parent_id is null;
  end if;
end $$;
