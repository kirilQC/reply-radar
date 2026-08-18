-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Which Granola meeting is a client's call, decided by title instead of by attendee domain.
--
-- The domain approach could not work. Granola's `GET /v1/notes` returns `NoteSummary` — created_at, id,
-- object, owner, title, updated_at — and attendees exist only on `GET /v1/notes/{id}`, with no way to
-- expand them on the list. Matching on attendees therefore costs one request per note: thirty notes per
-- key across ten keys is three hundred requests against a sustained limit of five a second, inside a
-- sixty-second function that also makes a model call. The title is already in the list response.
--
-- Null means "use the client's own name", which is right for nearly every client, so this stays empty
-- unless the calendar names somebody differently from the account — "Vitalic Health" invited as "Vitalic".

alter table if exists rr_workspaces add column if not exists granola_title_match text;

-- The old column is dropped rather than left behind: it is a text column full of domains that nothing
-- reads any more, and the next person to look at it would reasonably assume it was live.
alter table if exists rr_workspaces drop column if exists granola_domains;
