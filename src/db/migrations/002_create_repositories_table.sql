-- =============================================================================
-- Migration: 002_create_repositories_table
-- Description: Create repositories table for tracking cloned GitHub repos
-- Date: 2026-01-15
-- Depends: 001_create_users_table
-- =============================================================================

-- =============================================================================
-- Repositories Table
-- =============================================================================
-- Tracks GitHub repositories cloned to local filesystem for each user
-- One user can have multiple repos (limited by tier)

CREATE TABLE IF NOT EXISTS repositories (
    -- Primary Key
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Foreign Key to Users
    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,

    -- GitHub Repository Information
    github_repo_id INTEGER NOT NULL,
    github_org VARCHAR(255) NOT NULL,
    github_name VARCHAR(255) NOT NULL,
    github_url TEXT NOT NULL,
    github_description TEXT,
    github_default_branch VARCHAR(255) DEFAULT 'main',

    -- Local Clone Information
    local_path TEXT NOT NULL,                        -- e.g., ~/.gitflow-pm/org/repo
    is_cloned BOOLEAN NOT NULL DEFAULT false,
    cloned_at TIMESTAMP WITH TIME ZONE,

    -- Current State
    current_branch VARCHAR(255) NOT NULL DEFAULT 'main',
    last_accessed_at TIMESTAMP WITH TIME ZONE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Constraints
    -- Each user can only have one record per GitHub repo
    CONSTRAINT repositories_user_repo_unique UNIQUE (user_id, github_repo_id)
);

-- =============================================================================
-- Indexes
-- =============================================================================
-- Optimized for common access patterns

-- List cloned repos for a user (dashboard, repo picker)
CREATE INDEX IF NOT EXISTS idx_repositories_user_cloned
    ON repositories (user_id, is_cloned)
    WHERE is_cloned = true;

-- Find repos by organization (filtering)
CREATE INDEX IF NOT EXISTS idx_repositories_github_org
    ON repositories (github_org);

-- Recently accessed repos (sorting)
CREATE INDEX IF NOT EXISTS idx_repositories_last_accessed
    ON repositories (user_id, last_accessed_at DESC NULLS LAST)
    WHERE is_cloned = true;

-- Count repos per user (rate limiting check)
CREATE INDEX IF NOT EXISTS idx_repositories_user_count
    ON repositories (user_id);

-- =============================================================================
-- Trigger: Auto-update updated_at
-- =============================================================================

CREATE TRIGGER set_repositories_updated_at
    BEFORE UPDATE ON repositories
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE repositories IS 'Cloned GitHub repositories with local filesystem paths';
COMMENT ON COLUMN repositories.local_path IS 'Absolute path to local clone, e.g., ~/.gitflow-pm/wix/checkout';
COMMENT ON COLUMN repositories.is_cloned IS 'Whether the repo has been successfully cloned to local_path';
COMMENT ON COLUMN repositories.current_branch IS 'Currently checked out branch (may differ from github_default_branch)';
