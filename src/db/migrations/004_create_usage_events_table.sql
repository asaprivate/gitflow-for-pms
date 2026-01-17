-- =============================================================================
-- Migration: 004_create_usage_events_table
-- Description: Create usage_events table for analytics and audit logging
-- Date: 2026-01-15
-- Depends: 001_create_users_table, 002_create_repositories_table, 003_create_sessions_table
-- =============================================================================

-- =============================================================================
-- Usage Events Table
-- =============================================================================
-- Tracks all user actions for analytics, debugging, and audit purposes
-- High-volume table - consider partitioning by month for production

CREATE TABLE IF NOT EXISTS usage_events (
    -- Primary Key
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Foreign Keys (soft references - don't block deletes)
    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    repo_id UUID
        REFERENCES repositories(id) ON DELETE SET NULL,
    session_id UUID
        REFERENCES sessions(id) ON DELETE SET NULL,

    -- Event Information
    event_type VARCHAR(255) NOT NULL,                -- e.g., 'auth', 'clone', 'commit', 'push', 'pr_create', 'merge'
    event_data JSONB,                                -- Additional context (varies by event type)

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Indexes
-- =============================================================================
-- Optimized for analytics queries

-- User activity timeline
CREATE INDEX IF NOT EXISTS idx_usage_events_user_date
    ON usage_events (user_id, created_at DESC);

-- Event type analytics (e.g., count commits per day)
CREATE INDEX IF NOT EXISTS idx_usage_events_type_date
    ON usage_events (event_type, created_at DESC);

-- Recent events (global dashboard)
CREATE INDEX IF NOT EXISTS idx_usage_events_created
    ON usage_events (created_at DESC);

-- JSONB queries on event_data (for advanced analytics)
CREATE INDEX IF NOT EXISTS idx_usage_events_data
    ON usage_events USING GIN (event_data);

-- =============================================================================
-- Partitioning (for production - high volume)
-- =============================================================================
-- Uncomment for production to partition by month:
--
-- CREATE TABLE usage_events_partitioned (
--     LIKE usage_events INCLUDING ALL
-- ) PARTITION BY RANGE (created_at);
--
-- CREATE TABLE usage_events_2026_01 PARTITION OF usage_events_partitioned
--     FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE usage_events IS 'Audit log and analytics events for all user actions';
COMMENT ON COLUMN usage_events.event_type IS 'Event category: auth, clone, commit, push, pr_create, pr_merge, error, etc.';
COMMENT ON COLUMN usage_events.event_data IS 'JSONB payload with event-specific data (e.g., commit_hash, pr_number, error_message)';
