-- =============================================================================
-- Migration: 003_create_sessions_table
-- Description: Create sessions table for tracking active work sessions
-- Date: 2026-01-15
-- Depends: 001_create_users_table, 002_create_repositories_table
-- =============================================================================

-- =============================================================================
-- Sessions Table
-- =============================================================================
-- Tracks work sessions: task description, branch, commits, and PR lifecycle
-- A session represents a single task/feature from start to merge

CREATE TABLE IF NOT EXISTS sessions (
    -- Primary Key
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Foreign Keys
    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    repo_id UUID NOT NULL
        REFERENCES repositories(id) ON DELETE CASCADE,

    -- Task Information
    task_description TEXT,                           -- User-provided description
    current_branch VARCHAR(255) NOT NULL,            -- e.g., feature/add-stripe

    -- Pull Request Tracking
    pr_id INTEGER,                                   -- GitHub PR ID
    pr_number INTEGER,                               -- GitHub PR number (#1234)
    pr_url TEXT,                                     -- Full PR URL
    pr_created_at TIMESTAMP WITH TIME ZONE,
    pr_merged_at TIMESTAMP WITH TIME ZONE,

    -- Session Metrics
    commits_in_session INTEGER NOT NULL DEFAULT 0
        CHECK (commits_in_session >= 0),
    last_action VARCHAR(255),                        -- e.g., 'commit', 'push', 'merge'
    last_action_at TIMESTAMP WITH TIME ZONE,

    -- Lifecycle Status
    status VARCHAR(50) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'abandoned')),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Indexes
-- =============================================================================
-- Optimized for session lookup and analytics

-- Find active session for a user (most common query)
CREATE INDEX IF NOT EXISTS idx_sessions_user_active
    ON sessions (user_id, status)
    WHERE status = 'active';

-- Find active session for a repo
CREATE INDEX IF NOT EXISTS idx_sessions_repo_active
    ON sessions (repo_id, status)
    WHERE status = 'active';

-- Session history (sorted by start time)
CREATE INDEX IF NOT EXISTS idx_sessions_started_desc
    ON sessions (started_at DESC);

-- Analytics: sessions by status
CREATE INDEX IF NOT EXISTS idx_sessions_status
    ON sessions (status);

-- Find sessions with open PRs (for PR status updates)
CREATE INDEX IF NOT EXISTS idx_sessions_open_pr
    ON sessions (pr_number)
    WHERE pr_number IS NOT NULL AND pr_merged_at IS NULL;

-- Abandoned session cleanup (cron job)
CREATE INDEX IF NOT EXISTS idx_sessions_stale
    ON sessions (last_action_at)
    WHERE status = 'active';

-- =============================================================================
-- Trigger: Auto-update updated_at
-- =============================================================================

CREATE TRIGGER set_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE sessions IS 'Work sessions tracking tasks from creation through PR merge';
COMMENT ON COLUMN sessions.status IS 'Session lifecycle: active (in progress), completed (merged), abandoned (stale)';
COMMENT ON COLUMN sessions.current_branch IS 'Git branch for this session, e.g., feature/add-stripe-checkout';
COMMENT ON COLUMN sessions.last_action IS 'Most recent action: clone, commit, push, pull, merge, etc.';
