-- Workstream on a project task (Tech Stack, Events, List Building, Signal-Based, Always On, ...): the
-- coloured column of the Sheet view, the board layout for ops-only engagements. Free text so each client
-- can have its own; "Always On" is special — those tasks sit in the sheet's top section all engagement.
alter table rr_projects add column if not exists workstream text;
