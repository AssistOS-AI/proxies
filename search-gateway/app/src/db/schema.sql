SET search_path TO search_gateway, public;

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash TEXT UNIQUE NOT NULL,
    encrypted_key BYTEA NOT NULL,
    label TEXT,
    key_hint TEXT,
    rpm_limit INT DEFAULT 60,
    expires_at TIMESTAMPTZ,
    is_revoked BOOLEAN DEFAULT false,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Search Provider Configs
CREATE TABLE IF NOT EXISTS search_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    display_name TEXT,
    provider_type TEXT NOT NULL,
    base_url TEXT,
    encrypted_api_key BYTEA,
    key_hint TEXT,
    config JSONB DEFAULT '{}',
    monthly_quota INT,
    monthly_usage INT DEFAULT 0,
    quota_reset_at TIMESTAMPTZ,
    is_enabled BOOLEAN DEFAULT true,
    sort_order INT DEFAULT 100,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Search Models (virtual models exposed via /v1/models)
CREATE TABLE IF NOT EXISTS search_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    display_name TEXT,
    provider_id UUID REFERENCES search_providers(id) ON DELETE SET NULL,
    model_type TEXT DEFAULT 'search',
    config JSONB DEFAULT '{}',
    is_enabled BOOLEAN DEFAULT true,
    sort_order INT DEFAULT 100,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Search Logs (partitioned by month)
CREATE TABLE IF NOT EXISTS search_logs (
    id UUID DEFAULT gen_random_uuid(),
    api_key_id UUID,
    agent_name TEXT,
    requested_model TEXT,
    resolved_provider TEXT,
    search_query TEXT,
    search_params JSONB,
    is_streaming BOOLEAN DEFAULT false,
    request_messages JSONB,
    result_count INT,
    response_content TEXT,
    status_code INT,
    error_type TEXT,
    error_message TEXT,
    latency_ms INT,
    sub_query_count INT,
    sub_queries JSONB,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE INDEX IF NOT EXISTS idx_search_logs_started ON search_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_search_logs_model ON search_logs(resolved_provider, started_at);
CREATE INDEX IF NOT EXISTS idx_search_logs_key ON search_logs(api_key_id, started_at);
CREATE INDEX IF NOT EXISTS idx_search_logs_error ON search_logs(error_type) WHERE error_type IS NOT NULL;

-- Rate Limit State
CREATE TABLE IF NOT EXISTS rate_limit_state (
    key TEXT PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL,
    counter INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
);
