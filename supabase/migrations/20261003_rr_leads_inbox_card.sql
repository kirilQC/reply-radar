-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- The inbox shows ~10 fields per lead, but they live inside raw_data, whose AI Ark blob averages ~44KB.
-- Reading them as JSON paths made Postgres decompress the whole blob once per path on every inbox load.
-- This stores just those fields, computed on write. Keys match the aliases in app/api/inbox/route.ts.
-- jsonb_build_object is only STABLE, so a generated column cannot call it directly; the wrapper is
-- declared IMMUTABLE, which is true here (the output depends on its argument alone).
create or replace function public.rr_lead_inbox_card(raw jsonb) returns jsonb
language sql immutable parallel safe as $$
  select jsonb_build_object(
    'sender', raw->'reply_radar'->'sender',
    'campaign', raw->'reply_radar'->'campaign',
    'history_status', raw->'reply_radar'->'history_status',
    'icp_score', raw->'reply_radar'->'icp_score',
    'icp_reason', raw->'reply_radar'->'icp_reason',
    'ai_title', raw->'reply_radar'->'ai_ark'->'title',
    'ai_headline', raw->'reply_radar'->'ai_ark'->'headline',
    'ai_location', raw->'reply_radar'->'ai_ark'->'location',
    'ai_industry', raw->'reply_radar'->'ai_ark'->'industry',
    'ai_profilePhotoSource', raw->'reply_radar'->'ai_ark'->'profilePhotoSource',
    'ai_profilePhotoUrl', raw->'reply_radar'->'ai_ark'->'profilePhotoUrl',
    'ai_companyPhotoSource', raw->'reply_radar'->'ai_ark'->'companyPhotoSource',
    'ai_companyPhotoUrl', raw->'reply_radar'->'ai_ark'->'companyPhotoUrl',
    'ai_company_name', raw->'reply_radar'->'ai_ark'->'company'->'name',
    'ai_company_summary_name', raw->'reply_radar'->'ai_ark'->'company'->'summary'->'name',
    'pg0_company', raw->'reply_radar'->'ai_ark'->'positionGroups'->0->'company'->'name',
    'pg0_end', raw->'reply_radar'->'ai_ark'->'positionGroups'->0->'date'->'end',
    'pg1_company', raw->'reply_radar'->'ai_ark'->'positionGroups'->1->'company'->'name',
    'pg1_end', raw->'reply_radar'->'ai_ark'->'positionGroups'->1->'date'->'end'
  )
$$;

alter table rr_leads add column if not exists inbox_card jsonb
  generated always as (public.rr_lead_inbox_card(raw_data)) stored;

notify pgrst, 'reload schema';
