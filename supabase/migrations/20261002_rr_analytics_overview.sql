-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Analytics aggregates computed in Postgres instead of shipped row by row.
--
-- /api/analytics used to page every conversation and every message (raw_data included) of every
-- client into the function and count them there: tens of thousands of rows, hundreds of requests,
-- 7-17 seconds. These two functions return the same counts already grouped, a few hundred rows.
--
-- Both routes call these when they exist and fall back to the row-by-row read when they do not
-- (PostgREST answers 404), so applying this is optional and reversible (`drop function ...`).
--
-- Fidelity notes (the JS that consumes these does every string normalisation itself):
--   * campaign / sender / sentiment are returned as the raw jsonb values (`->`, not `->>`), exactly
--     what the old code read off the parsed raw_data object, so `String(value ?? fallback)` in JS
--     gives the same names as before.
--   * first_seq reproduces the order the old route met each message in: workspaces in the order
--     passed (batched 20 at a time), conversations by id within a workspace batch, conversations
--     batched 20 at a time, messages by (sent_at, id) within a conversation batch. That order decides
--     top-12 ties and the order of each campaign's client list.
--   * Response times use whole milliseconds (JS Date truncates microseconds) and the same
--     "inbound directly after an outbound" rule as the old per-thread walk.
--   * Days are New York calendar days, like easternDayKey() in the route.

create or replace function public.rr_analytics_overview(
  p_workspace_ids uuid[],
  p_week_ago timestamptz,
  p_trend_since timestamptz
) returns jsonb
language sql
stable
set search_path = public
as $$
  with ws as (
    select w.id, (w.ord - 1) / 20 as ws_batch
    from unnest(p_workspace_ids) with ordinality as w(id, ord)
  ),
  conv as (
    select c.id, c.workspace_id, c.tier,
           row_number() over (order by ws.ws_batch, c.id) as conv_rank
    from rr_conversations c
    join ws on ws.id = c.workspace_id
  ),
  msg as (
    select m.id, m.conversation_id, m.direction, m.sent_at, conv.workspace_id,
           (conv.conv_rank - 1) / 20 as conv_batch,
           m.raw_data -> 'reply_radar' -> 'campaign' -> 'name' as campaign,
           m.raw_data -> 'reply_radar' -> 'sender' -> 'name' as sender,
           m.raw_data -> 'reply_radar' -> 'sentiment' as sentiment
    from rr_messages m
    join conv on conv.id = m.conversation_id
  ),
  seq as (
    select msg.*, row_number() over (order by conv_batch, sent_at, id) - 1 as seq
    from msg
  ),
  grouped as (
    select workspace_id, direction, campaign, sender,
           case when direction = 'inbound' then sentiment end as sentiment,
           (direction = 'inbound' and sent_at >= p_week_ago) as recent,
           count(*) as n,
           min(seq) as first_seq
    from seq
    group by 1, 2, 3, 4, 5, 6
  ),
  threaded as (
    select direction,
           floor(extract(epoch from sent_at) * 1000)::bigint as ms,
           lag(direction) over w as prev_direction,
           floor(extract(epoch from lag(sent_at) over w) * 1000)::bigint as prev_ms
    from msg
    where direction in ('inbound', 'outbound')
    window w as (partition by conversation_id order by sent_at, id)
  ),
  days as (
    select to_char(sent_at at time zone 'America/New_York', 'YYYY-MM-DD') as day, count(*) as n
    from msg
    where direction = 'inbound' and sent_at >= p_trend_since
    group by 1
  )
  select jsonb_build_object(
    'conversations', (
      select coalesce(jsonb_agg(jsonb_build_object('workspace_id', workspace_id, 'tier', tier, 'n', n)), '[]'::jsonb)
      from (select workspace_id, tier, count(*) as n from conv group by 1, 2) t
    ),
    'messages', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'workspace_id', workspace_id, 'direction', direction, 'campaign', campaign, 'sender', sender,
        'sentiment', sentiment, 'recent', recent, 'n', n, 'first_seq', first_seq
      ) order by first_seq), '[]'::jsonb)
      from grouped
    ),
    'inbound_by_day', (select coalesce(jsonb_object_agg(day, n), '{}'::jsonb) from days),
    'response', (
      select jsonb_build_object('sum_ms', coalesce(sum(ms - prev_ms), 0), 'n', count(*))
      from threaded
      where direction = 'inbound' and prev_direction = 'outbound' and prev_ms <> 0 and ms >= prev_ms
    )
  );
$$;

create or replace function public.rr_analytics_client_replies(
  p_workspace_id uuid,
  p_week_ago timestamptz
) returns jsonb
language sql
stable
set search_path = public
as $$
  with conv as (
    select id from rr_conversations where workspace_id = p_workspace_id
  ),
  inbound as (
    select m.sent_at,
           m.raw_data -> 'reply_radar' -> 'campaign' ->> 'name' as campaign,
           m.raw_data -> 'reply_radar' ->> 'sentiment' as sentiment
    from rr_messages m
    join conv on conv.id = m.conversation_id
    where m.direction = 'inbound'
  )
  select jsonb_build_object(
    'conversations', (select count(*) from conv),
    'groups', (
      select coalesce(jsonb_agg(jsonb_build_object('campaign', campaign, 'sentiment', sentiment, 'recent', recent, 'n', n)), '[]'::jsonb)
      from (
        select campaign, sentiment, sent_at >= p_week_ago as recent, count(*) as n
        from inbound
        group by 1, 2, 3
      ) g
    )
  );
$$;

revoke all on function public.rr_analytics_overview(uuid[], timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.rr_analytics_client_replies(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.rr_analytics_overview(uuid[], timestamptz, timestamptz) to service_role;
grant execute on function public.rr_analytics_client_replies(uuid, timestamptz) to service_role;

-- Make PostgREST see the new functions without a restart.
notify pgrst, 'reload schema';
