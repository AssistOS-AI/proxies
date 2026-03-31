# DS006 -- Database Schema

## Summary

This specification describes the PostgreSQL database schema used by Soul Gateway, including all tables, columns, types, constraints, indexes, and the monthly partitioning strategy for call logs.

## Problem

Soul Gateway needs persistent storage for API keys, model configurations, provider configurations, blacklist rules, call logs, middleware registrations, middleware assignments, and rate-limit state. The call log table grows continuously and must be partitioned for query performance and data retention.

## Design

### Schema

All tables are created in the `soul_gateway` schema:

```sql
CREATE SCHEMA IF NOT EXISTS soul_gateway;
SET search_path TO soul_gateway;
```

### Table: api_keys

Stores client API keys with encrypted values and per-key limits.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique key identifier |
| key_hash | TEXT | | UNIQUE NOT NULL | SHA-256 hash for lookup |
| encrypted_key | BYTEA | | NOT NULL | AES-256 encrypted key |
| label | TEXT | | | Human-readable label |
| key_hint | TEXT | | | Last 4 chars for display |
| monthly_budget | NUMERIC | NULL | | Monthly cost budget (NULL = unlimited) |
| daily_budget | NUMERIC | 2 | | Daily cost budget |
| rpm_limit | INT | 60 | | Requests per minute limit |
| tpm_limit | INT | 100000 | | Tokens per minute limit |
| expires_at | TIMESTAMPTZ | | | Expiration timestamp |
| is_revoked | BOOLEAN | false | | Revocation flag |
| last_used_at | TIMESTAMPTZ | | | Last authentication time |
| created_at | TIMESTAMPTZ | now() | | Creation time |

### Table: model_configs

Unified table for both individual models and tiers. The `type` column distinguishes them.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| name | TEXT | | UNIQUE NOT NULL | Model or tier name (e.g., `axl/copilot/gpt-4o`) |
| display_name | TEXT | | | Human-readable name |
| upstream_model | TEXT | | | Legacy: upstream model reference |
| provider_key | TEXT | | | Provider identifier (e.g., `copilot`) |
| provider_model | TEXT | | | Upstream model name (e.g., `gpt-4o`) |
| upstream_source | TEXT | | | Legacy: upstream source |
| mode | TEXT | 'deep' | | Model mode (deep/fast) |
| input_price | NUMERIC | 0 | | Price per 1M input tokens |
| output_price | NUMERIC | 0 | | Price per 1M output tokens |
| pricing_type | TEXT | 'token' | | 'token' or 'request' |
| request_cost | NUMERIC | 0 | | Flat cost for request-priced models |
| max_concurrency | INT | 3 | | Max concurrent requests |
| sort_order | INT | 100 | | Display ordering |
| context_window | TEXT | | | Context window size |
| is_enabled | BOOLEAN | true | | Enable/disable flag |
| tags | TEXT[] | '{}' | | Tag array for categorization |
| type | TEXT | 'model' | CHECK (type IN ('model', 'tier')) | Entry type |
| model_refs | TEXT[] | '{}' | | Tier: ordered list of model names |
| fallback_model | TEXT | | | Tier: fallback tier name |
| created_at | TIMESTAMPTZ | now() | | Creation time |

### Table: provider_configs

Upstream LLM provider connection details.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| name | TEXT | | UNIQUE NOT NULL | Provider identifier |
| display_name | TEXT | | | Human-readable name |
| protocol | TEXT | 'openai' | NOT NULL | API protocol (openai/anthropic) |
| base_url | TEXT | | NOT NULL | Provider base URL |
| encrypted_api_key | BYTEA | | | AES-256 encrypted static API key |
| key_hint | TEXT | | | Last 4 chars for display |
| billing_type | TEXT | 'api_key' | | Billing type (api_key/free) |
| auth_type | TEXT | 'api_key' | | Auth type (api_key/managed) |
| is_enabled | BOOLEAN | true | | Enable/disable flag |
| created_at | TIMESTAMPTZ | now() | | Creation time |
| updated_at | TIMESTAMPTZ | now() | | Last update time |

### Table: blacklist_rules

Content filtering rules.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| pattern | TEXT | | NOT NULL | Match pattern |
| match_type | TEXT | | CHECK (IN ('exact', 'substring', 'regex')) NOT NULL | How to match |
| action | TEXT | 'block' | | Action on match |
| description | TEXT | | | Rule description |
| is_enabled | BOOLEAN | true | | Enable/disable flag |
| created_at | TIMESTAMPTZ | now() | | Creation time |

### Table: call_logs (Partitioned)

The main audit log table, partitioned by month on `started_at`.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Log entry ID |
| soul_id | TEXT | | Client soul identifier |
| api_key_id | UUID | | Authenticated key ID |
| agent_name | TEXT | | Agent name from headers |
| session_id | UUID | | Session ID from headers |
| requested_model | TEXT | | Model name from request |
| resolved_model | TEXT | | Actually used model |
| mode | TEXT | | Model mode |
| is_streaming | BOOLEAN | | Whether streaming was requested |
| request_messages | JSONB | | Full request messages |
| request_size_bytes | INT | | Request content size |
| response_content | TEXT | | Full response text |
| status_code | INT | | HTTP status code |
| stop_reason | TEXT | | LLM stop reason |
| error_type | TEXT | | Error classification type |
| error_message | TEXT | | Error message |
| response_size_bytes | INT | | Response content size |
| latency_ms | INT | | Total request latency |
| ttfb_ms | INT | | Time to first byte |
| prompt_tokens | INT | | Prompt token count |
| completion_tokens | INT | | Completion token count |
| total_tokens | INT | | Total token count |
| input_cost | NUMERIC | | Input token cost |
| output_cost | NUMERIC | | Output token cost |
| total_cost | NUMERIC | | Total request cost |
| retry_count | INT | 0 | Number of retries |
| retry_reason | TEXT | | Last retry reason |
| retries_detail | JSONB | | Per-attempt retry details |
| blocked_by_blacklist | BOOLEAN | false | Blacklist block flag |
| blacklist_rule_id | UUID | | Matching rule ID |
| blacklist_match | TEXT | | Matched pattern excerpt |
| is_truncated | BOOLEAN | false | Response truncated flag |
| is_slow | BOOLEAN | false | Slow request flag |
| prompt_size_warning | BOOLEAN | false | Large prompt flag |
| prompt_hash | TEXT | | SHA-256 of messages+model |
| cache_hit | BOOLEAN | false | Cache hit flag |
| started_at | TIMESTAMPTZ | | Request start time |
| completed_at | TIMESTAMPTZ | | Request completion time |

**Primary Key:** Composite `(id, started_at)` -- required for range partitioning.

**Partition Strategy:** `PARTITION BY RANGE (started_at)`. New partitions are created automatically for each month (e.g., `call_logs_2026_03`). Partitions older than `config.retentionDays` (90 days) are dropped.

### Indexes on call_logs

| Index | Columns | Condition |
|-------|---------|-----------|
| idx_call_logs_soul_started | (soul_id, started_at) | |
| idx_call_logs_model_started | (resolved_model, started_at) | |
| idx_call_logs_started | (started_at) | |
| idx_call_logs_error | (error_type) | WHERE error_type IS NOT NULL |
| idx_call_logs_blocked | (blocked_by_blacklist) | WHERE blocked_by_blacklist = true |
| idx_call_logs_session | (api_key_id, session_id, started_at) | |
| idx_call_logs_key_started | (api_key_id, started_at) | |

### Table: middlewares

Registry of discovered middleware plugins.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| name | TEXT | | UNIQUE NOT NULL | Middleware name |
| description | TEXT | | | Human-readable description |
| file_name | TEXT | | NOT NULL | Source file name |
| type | TEXT | 'both' | CHECK (IN ('pre', 'post', 'both')) | Hook type |
| supports_streaming | BOOLEAN | false | | Can process streaming responses |
| default_settings | JSONB | '{}' | | Default configuration |
| version | TEXT | '1.0.0' | | Version string |
| is_discovered | BOOLEAN | true | | Present on disk |
| created_at | TIMESTAMPTZ | now() | | First discovery time |
| updated_at | TIMESTAMPTZ | now() | | Last update time |

### Table: model_middlewares

Junction table assigning middlewares to models/tiers with per-assignment configuration.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| model_config_id | UUID | | REFERENCES model_configs(id) ON DELETE CASCADE, NOT NULL | Target model or tier |
| middleware_id | UUID | | REFERENCES middlewares(id) ON DELETE CASCADE, NOT NULL | Assigned middleware |
| is_enabled | BOOLEAN | true | | Enable/disable flag |
| sort_order | INT | 100 | | Execution order |
| settings | JSONB | '{}' | | Per-assignment setting overrides |
| created_at | TIMESTAMPTZ | now() | | Creation time |
| updated_at | TIMESTAMPTZ | now() | | Last update time |

**Unique constraint:** `(model_config_id, middleware_id)` -- each middleware can be assigned to a model at most once.

**Indexes:** `idx_model_middlewares_model` on `(model_config_id)`, `idx_model_middlewares_order` on `(model_config_id, sort_order)`.

### Table: rate_limit_state

Sliding window counters for rate limiting (survives process restarts).

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| key | TEXT | | PRIMARY KEY | Rate limit key (e.g., `rpm:key:<uuid>`) |
| window_start | TIMESTAMPTZ | | NOT NULL | Start of current window |
| counter | INT | 0 | | Request/token count |
| updated_at | TIMESTAMPTZ | now() | | Last update time |

## Implementation

| File | Role |
|------|------|
| `db/schema.sql` | DDL for all tables |
| `db/init.mjs` | Connection pool, schema creation, migration, partition management |
| `db/keys-dao.mjs` | API key CRUD and resolution |
| `db/models-dao.mjs` | Model and tier CRUD |
| `db/providers-dao.mjs` | Provider CRUD |
| `db/blacklist-dao.mjs` | Blacklist rule CRUD |
| `db/logs-dao.mjs` | Log insertion and queries |
| `db/middlewares-dao.mjs` | Middleware and model_middleware CRUD |

## Dependencies

- DS001 (Request Pipeline) -- pipeline writes to call_logs
- DS003 (Middleware Framework) -- middlewares and model_middlewares tables
- DS004 (Model Routing) -- model_configs table with type/model_refs/fallback
- DS007 (Rate Limiting & Budgets) -- rate_limit_state table
- DS008 (Content Filtering) -- blacklist_rules table
