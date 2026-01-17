-- =============================================================================
-- Migration: 001_create_users_table
-- Description: Create users table for authentication and subscription management
-- Date: 2026-01-15
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- Users Table
-- =============================================================================
-- Stores authenticated users with GitHub OAuth and Stripe billing information
-- Token storage: github_token_encrypted should be encrypted at application level
-- using AES-256-GCM before storage. NEVER store plaintext tokens.

CREATE TABLE IF NOT EXISTS users (
    -- Primary Key
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- GitHub OAuth Integration
    github_id INTEGER NOT NULL,
    github_username VARCHAR(255) NOT NULL,
    github_email VARCHAR(255),
    github_token_encrypted TEXT NOT NULL,           -- AES-256-GCM encrypted token
    github_token_expires_at TIMESTAMP WITH TIME ZONE,

    -- Account Information
    tier VARCHAR(50) NOT NULL DEFAULT 'free'
        CHECK (tier IN ('free', 'pro', 'enterprise')),
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    avatar_url TEXT,

    -- Stripe Billing
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    subscription_status VARCHAR(50)
        CHECK (subscription_status IS NULL OR subscription_status IN ('active', 'past_due', 'cancelled', 'trialing')),
    subscription_renews_at TIMESTAMP WITH TIME ZONE,

    -- Usage Tracking (reset monthly by cron job)
    commits_used_this_month INTEGER NOT NULL DEFAULT 0
        CHECK (commits_used_this_month >= 0),
    prs_created_this_month INTEGER NOT NULL DEFAULT 0
        CHECK (prs_created_this_month >= 0),
    repos_accessed_count INTEGER NOT NULL DEFAULT 0
        CHECK (repos_accessed_count >= 0),
    last_reset_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,              -- Soft delete for GDPR

    -- Constraints
    CONSTRAINT users_github_id_unique UNIQUE (github_id),
    CONSTRAINT users_email_unique UNIQUE (email),
    CONSTRAINT users_stripe_customer_id_unique UNIQUE (stripe_customer_id),
    CONSTRAINT users_stripe_subscription_id_unique UNIQUE (stripe_subscription_id)
);

-- =============================================================================
-- Indexes
-- =============================================================================
-- Optimized for common query patterns

-- Primary lookup by GitHub ID (OAuth flow)
CREATE INDEX IF NOT EXISTS idx_users_github_id ON users (github_id);

-- Billing queries by Stripe customer
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

-- Filter by subscription tier (analytics, rate limiting)
CREATE INDEX IF NOT EXISTS idx_users_tier ON users (tier);

-- Email lookup (password reset, notifications)
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Active users only (exclude soft-deleted)
CREATE INDEX IF NOT EXISTS idx_users_active ON users (id)
    WHERE deleted_at IS NULL;

-- Users needing monthly reset (cron job query)
CREATE INDEX IF NOT EXISTS idx_users_needs_reset ON users (last_reset_at)
    WHERE deleted_at IS NULL;

-- =============================================================================
-- Trigger: Auto-update updated_at
-- =============================================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE users IS 'Authenticated users with GitHub OAuth and Stripe billing';
COMMENT ON COLUMN users.github_token_encrypted IS 'AES-256-GCM encrypted GitHub OAuth token - NEVER log or expose';
COMMENT ON COLUMN users.deleted_at IS 'Soft delete timestamp for GDPR compliance (right to be forgotten)';
COMMENT ON COLUMN users.last_reset_at IS 'When usage counters were last reset (monthly cron job)';
COMMENT ON COLUMN users.tier IS 'Subscription tier: free (5 commits/mo), pro (unlimited), enterprise (custom)';
