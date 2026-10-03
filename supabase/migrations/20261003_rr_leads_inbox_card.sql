-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- The inbox shows ~10 fields per lead, but they live inside raw_data, whose AI Ark blob averages ~44KB.
-- Reading them as JSON paths made Postgres decompress the whole blob once per path on every inbox load.
-- This stores just those fields, computed on write. Keys match the aliases in app/api/inbox/route.ts.
alter table rr_leads add column if not exists inbox_card jsonb generated always as (jsonb_build_object(
  'sender', raw_data->'reply_radar'->'sender',
  'campaign', raw_data->'reply_radar'->'campaign',
  'history_status', raw_data->'reply_radar'->'history_status',
  'icp_score', raw_data->'reply_radar'->'icp_score',
  'icp_reason', raw_data->'reply_radar'->'icp_reason',
  'ai_title', raw_data->'reply_radar'->'ai_ark'->'title',
  'ai_headline', raw_data->'reply_radar'->'ai_ark'->'headline',
  'ai_location', raw_data->'reply_radar'->'ai_ark'->'location',
  'ai_industry', raw_data->'reply_radar'->'ai_ark'->'industry',
  'ai_profilePhotoSource', raw_data->'reply_radar'->'ai_ark'->'profilePhotoSource',
  'ai_profilePhotoUrl', raw_data->'reply_radar'->'ai_ark'->'profilePhotoUrl',
  'ai_companyPhotoSource', raw_data->'reply_radar'->'ai_ark'->'companyPhotoSource',
  'ai_companyPhotoUrl', raw_data->'reply_radar'->'ai_ark'->'companyPhotoUrl',
  'ai_company_name', raw_data->'reply_radar'->'ai_ark'->'company'->'name',
  'ai_company_summary_name', raw_data->'reply_radar'->'ai_ark'->'company'->'summary'->'name',
  'pg0_company', raw_data->'reply_radar'->'ai_ark'->'positionGroups'->0->'company'->'name',
  'pg0_end', raw_data->'reply_radar'->'ai_ark'->'positionGroups'->0->'date'->'end',
  'pg1_company', raw_data->'reply_radar'->'ai_ark'->'positionGroups'->1->'company'->'name',
  'pg1_end', raw_data->'reply_radar'->'ai_ark'->'positionGroups'->1->'date'->'end'
)) stored;

notify pgrst, 'reload schema';
