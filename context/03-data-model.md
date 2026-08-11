# 3. Data model

## Tables

All prefixed `rr_` so nothing collides with the unrelated tables in the same Supabase project.
**Never drop, rename or alter an un-prefixed table.**

| Table | Holds |
|---|---|
| `rr_workspaces` | One row per **client**. Name, slug, HeyReach key, branding, AI settings, guardrails, freshness timestamps. |
| `rr_profiles` | One row per **teammate**. Name, avatar. |
| `rr_profile_workspaces` | Which teammate is assigned to which client. Composite PK. |
| `rr_profile_preferences` | Per-teammate `appearance` and `inbox_layout` JSON. |
| `rr_device_preferences` | The same, keyed by device, for the general inbox where no profile is selected. |
| `rr_global_config` | App-wide settings. |
| `rr_leads` | One row per **lead per client**. A person working with three clients is three rows. |
| `rr_conversations` | One thread. `workspace_id`, `lead_id`, `external_id`, score/tier, `last_message_at`. |
| `rr_messages` | One message. `conversation_id`, `direction`, `body`, `sent_at`, `raw_data`. |
| `rr_scores` | Historical scoring rows. **May not exist in a given database.** See below. |
| `rr_documents` | Per-client uploaded files (Supabase Storage paths). |
| `rr_graphs` | Saved chart definitions. |
| `rr_webhook_events` | Every inbound webhook, with a deterministic `event_key` for idempotency. |
| `rr_sync_runs` | Worker heartbeats and sync results. This is what the health page reads. |
| `rr_audit_log` | Actor/action trail. |

Uniqueness constraints that matter: `rr_leads (workspace_id, external_id)`,
`rr_conversations (workspace_id, external_id)`, `rr_messages (conversation_id, external_id)`. These
are what make webhook redelivery safe to upsert.

## ⚠️ `supabase/schema.sql` has drifted from production

**Do not trust the file. Inspect the real columns in Supabase before writing a query.** Several
outages came from code assuming a column that was not there.

Concrete, verified divergences as of this writing:

| Table | The file says | The app actually uses |
|---|---|---|
| `rr_leads` | `title`, `profile_url` | `role`, `linkedin_id`, `linkedin_profile_url` |
| `rr_sync_runs` | no `run_type` column | worker writes `run_type: "heartbeat"` every cycle |
| `rr_global_config` | `id boolean primary key`, no `key`/`value` | app upserts `{ key, value }` with `Prefer: resolution=merge-duplicates` |
| `rr_scores` | declared, with `on delete cascade` | may not exist at all |

Consequences already baked into the code:

- `app/lib/lead-deletion.ts` deletes children **explicitly** rather than relying on
  `on delete cascade`, because whether the cascade exists is a property of whichever migration
  actually ran — not something the code can observe.
- The same file passes `tolerateMissingTable: true` when deleting from `rr_scores`, turning a `404`
  into `0`. A table that isn't there holds no rows to orphan.
- The worker has previously crashed on `rr_sync_runs` schema mismatch twice (`run_type` missing, then
  `run_type NOT NULL`). Make the insert payload match the real table; do not add speculative
  migrations.

If you fix the schema file, fix it by reading production, not by reading the code.

## Where AI state lives

**In JSON, not columns.** Adding a new signal therefore never needs a migration — which is the whole
point, given the drift above.

### `rr_messages.raw_data.reply_radar`

| Key | Meaning |
|---|---|
| `sentiment` | Classification of an inbound message. |
| `analyzed_at` | When sentiment was written. Presence is how the sweep knows to skip it. |
| `cached_draft` | The pre-written reply. |
| `cached_reason` | Why that draft. |
| `followup_urgency` | Urgency score for the thread. |
| `followup_reason` | Why. |
| `followup_analyzed_at` | When. |
| `sender` | `{ id, name }` of the sending profile. |
| `campaign` | `{ id, name }`. **Presence of a campaign is the decisive outbound signal** — see the origin classifier. |
| `conversation` | HeyReach conversation metadata. |
| `source` | `"webhook"`, `"history"` or `"refresh"`. Used by `dedupeMessages`. |

Also, outside `reply_radar`: `raw_data.webhook_message` holds the webhook copy of a message that was
merged into an API history row, so the merge loses nothing.

### `rr_leads.raw_data.reply_radar`

| Key | Meaning |
|---|---|
| `icp_score`, `icp_reason`, `icp_scored_at` | ICP scoring result. |
| `ai_ark` | Raw AI Ark enrichment payload. |
| `enrichment_status` | Success/failure; drives the 7-day retry backoff. |
| `history_status` | `"complete"` when the full thread was retrieved. **The origin classifier requires this to equal `"complete"` before it will ever conclude the lead messaged first.** |
| `history_fetched_at` | When. |
| `attributions` | Distinct campaigns and senders that touched this person. |
| `rollup` | Readable semicolon summary across clients, campaigns and senders. |

### `rr_workspaces` configuration

Columns: `client_brief`, `anthropic_model`, `custom_system_prompt`,
`heyreach_api_key_ciphertext` (**not actually encrypted** — the name is historical),
`logo_url`, `accent_color`, `webhook_url`.

`guardrails` JSON: `icp_prompt`, `follow_up_prompt`, `reply_prompt`, `follow_up_threshold`,
`messaging_doc_url`, `quick_templates`.

## Identity: "a lead" is a person, not a row

This is the single most important modelling fact in the codebase.

`rr_leads` is keyed per client. The **lead drawer merges every row sharing
`linkedin_profile_url`** into one person, showing all their clients, campaigns and conversations
together. So:

- **Deletion must be person-scoped.** `relatedLeadIds()` resolves the clicked row to every row for
  that profile URL. Deleting only the clicked row leaves the person visible under another client.
- Attribution and rollup (`app/lib/lead-identity.ts`) exist to summarise across those rows.
- Any new feature that acts on "a lead" must decide, explicitly, whether it means the row or the
  person — and say which in a comment.
