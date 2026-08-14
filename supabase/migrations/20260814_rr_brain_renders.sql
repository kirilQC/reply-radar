-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Reply Radar: the readable layouts of QC Brain documents.
--
-- The brain's documents are markdown written for a text editor, and the app asks a model to lay one
-- out again — headings, tables, a row of figures — so people actually read it. That call costs money
-- and takes half a minute, and the result depends only on the file's contents, so it is kept.
--
-- `source_sha` is the git blob SHA of the file the layout was made from. It is what makes this a cache
-- rather than a copy: when somebody edits the document in GitHub the SHA changes, the cached row stops
-- matching, and the layout is made again from the new text. Nothing here is ever written back to the
-- brain repository.
--
-- Safe to run more than once.

create table if not exists rr_brain_renders (
  path text primary key,
  source_sha text not null,
  markdown text not null,
  model text,
  -- Figures in the layout that are not in the source, and how much of the source's length survived.
  -- Kept with the row so the page can show the same warning to the second reader as to the first.
  warnings jsonb not null default '{}'::jsonb,
  rendered_at timestamptz not null default now()
);

alter table if exists rr_brain_renders add column if not exists source_sha text;
alter table if exists rr_brain_renders add column if not exists markdown text;
alter table if exists rr_brain_renders add column if not exists model text;
alter table if exists rr_brain_renders add column if not exists warnings jsonb;
alter table if exists rr_brain_renders add column if not exists rendered_at timestamptz;

update rr_brain_renders set warnings = coalesce(warnings, '{}'::jsonb) where warnings is null;
update rr_brain_renders set rendered_at = coalesce(rendered_at, now()) where rendered_at is null;

alter table rr_brain_renders alter column warnings set default '{}'::jsonb;
alter table rr_brain_renders alter column rendered_at set default now();

alter table rr_brain_renders enable row level security;
