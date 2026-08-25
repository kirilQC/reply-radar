-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- The invitee's profile photo and the company logo, filled by meeting enrichment so the meeting page can
-- show a face and a brand mark instead of initials and a placeholder. Both are URLs (the enrichment persists
-- the images into the reply-radar-enrichment storage bucket).
alter table rr_meetings
  add column if not exists invitee_photo_url text,
  add column if not exists company_logo_url text;
