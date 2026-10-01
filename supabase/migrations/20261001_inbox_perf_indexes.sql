-- Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
-- Reply Radar — proprietary. Not licensed for redistribution or resale.

-- Inbox performance: the indexes the hot read paths were missing.
--
-- The inbox loads every message for the ~500 newest conversations with
--   rr_messages ... conversation_id=in.(…) order by sent_at
-- but rr_messages had an index on sent_at ONLY, never on conversation_id (a foreign key does not
-- create one). So that read was a full sequential scan of the whole messages table on every inbox
-- load and every worker AI sweep. A composite (conversation_id, sent_at) index turns it into an index
-- scan that also serves the per-conversation ordering.
--
-- The conversation list reads `workspace_id=in.(…) order by last_message_at desc`; the existing
-- (workspace_id, tier) index does not help that sort, so a (workspace_id, last_message_at desc) index
-- is added for it (and for the custom-range filter on last_message_at).
--
-- CONCURRENTLY so building them does not lock the live tables. Run each statement on its own in the
-- Supabase SQL editor (CONCURRENTLY cannot run inside a transaction block).

create index concurrently if not exists rr_messages_conversation_sent_idx on rr_messages (conversation_id, sent_at);

create index concurrently if not exists rr_conversations_workspace_last_message_idx on rr_conversations (workspace_id, last_message_at desc);

-- The score-history table is also keyed by conversation and read on the lead detail path.
create index concurrently if not exists rr_score_events_conversation_idx on rr_score_events (conversation_id);
