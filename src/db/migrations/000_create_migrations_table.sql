-- =============================================================================
-- Migration: 000_create_migrations_table
-- Description: Create migrations tracking table (must run first)
-- Date: 2026-01-15
-- =============================================================================

-- This table tracks which migrations have been applied
-- The migration runner checks this before executing each migration

CREATE TABLE IF NOT EXISTS schema_migrations (
    -- Migration identifier (filename without .sql)
    version VARCHAR(255) PRIMARY KEY,

    -- Execution metadata
    applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    execution_time_ms INTEGER,
    checksum VARCHAR(64)                             -- SHA-256 of migration content
);

COMMENT ON TABLE schema_migrations IS 'Tracks applied database migrations';
COMMENT ON COLUMN schema_migrations.version IS 'Migration filename (e.g., 001_create_users_table)';
COMMENT ON COLUMN schema_migrations.checksum IS 'SHA-256 hash of migration file content for drift detection';
