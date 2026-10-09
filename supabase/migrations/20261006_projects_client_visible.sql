-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- "Show to client" on a project task: the task appears on that client's read-only Project tracker in
-- QC Portal (title, stage, owner, priority and dates only). Off by default, so nothing is shared until
-- someone on the team ticks it. Moving a task to another client resets it (tasks route).
alter table rr_projects add column if not exists client_visible boolean not null default false;

create index if not exists rr_projects_client_visible
  on rr_projects (workspace_id) where client_visible;
