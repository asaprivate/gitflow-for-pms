/**
 * Core type definitions for GitFlow MCP Server
 *
 * This module contains all shared TypeScript interfaces, types, and enums
 * used throughout the application.
 */

// ============================================================================
// User & Authentication Types
// ============================================================================

/**
 * User subscription tier levels
 */
export enum UserTier {
  FREE = 'free',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

/**
 * Subscription status types
 */
export enum SubscriptionStatus {
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
  TRIALING = 'trialing',
}

/**
 * User entity representing an authenticated user
 */
export interface IUser {
  readonly id: string;
  readonly githubId: number;
  readonly githubUsername: string;
  readonly githubEmail: string | null;
  readonly tier: UserTier;
  readonly email: string;
  readonly fullName: string | null;
  readonly avatarUrl: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly subscriptionStatus: SubscriptionStatus | null;
  readonly subscriptionRenewsAt: Date | null;
  readonly commitsUsedThisMonth: number;
  readonly prsCreatedThisMonth: number;
  readonly reposAccessedCount: number;
  readonly lastResetAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastLoginAt: Date | null;
  readonly deletedAt: Date | null;
}

/**
 * Data required to create a new user
 */
export interface ICreateUserData {
  readonly githubId: number;
  readonly githubUsername: string;
  readonly githubEmail: string | null;
  readonly email: string;
  readonly fullName: string | null;
  readonly avatarUrl: string | null;
}

// ============================================================================
// Repository Types
// ============================================================================

/**
 * Repository entity representing a cloned GitHub repository
 */
export interface IRepository {
  readonly id: string;
  readonly userId: string;
  readonly githubRepoId: number;
  readonly githubOrg: string;
  readonly githubName: string;
  readonly githubUrl: string;
  readonly githubDescription: string | null;
  readonly localPath: string;
  readonly isCloned: boolean;
  readonly clonedAt: Date | null;
  readonly currentBranch: string;
  readonly lastAccessedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Data required to create a repository record
 */
export interface ICreateRepositoryData {
  readonly userId: string;
  readonly githubRepoId: number;
  readonly githubOrg: string;
  readonly githubName: string;
  readonly githubUrl: string;
  readonly githubDescription: string | null;
  readonly localPath: string;
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Session status types
 */
export enum SessionStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  ABANDONED = 'abandoned',
}

/**
 * Session entity representing an active work session
 */
export interface ISession {
  readonly id: string;
  readonly userId: string;
  readonly repoId: string;
  readonly taskDescription: string | null;
  readonly currentBranch: string;
  readonly prId: number | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly prCreatedAt: Date | null;
  readonly prMergedAt: Date | null;
  readonly commitsInSession: number;
  readonly lastAction: string | null;
  readonly lastActionAt: Date | null;
  readonly status: SessionStatus;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Data required to create a new session
 */
export interface ICreateSessionData {
  readonly userId: string;
  readonly repoId: string;
  readonly taskDescription: string | null;
  readonly currentBranch: string;
}

// ============================================================================
// Git Operation Types
// ============================================================================

/**
 * Git repository status information
 */
export interface IGitStatus {
  readonly currentBranch: string;
  readonly modifiedFiles: readonly string[];
  readonly stagedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly isClean: boolean;
  readonly ahead: number;
  readonly behind: number;
}

/**
 * Git commit result
 */
export interface IGitCommitResult {
  readonly commitHash: string;
  readonly message: string;
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * Git push result
 */
export interface IGitPushResult {
  readonly success: boolean;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly error?: string;
}

/**
 * Git pull result
 */
export interface IGitPullResult {
  readonly success: boolean;
  readonly newCommits: number;
  readonly hasConflicts: boolean;
  readonly conflictFiles: readonly string[];
}

/**
 * Git merge result
 */
export interface IGitMergeResult {
  readonly success: boolean;
  readonly hasConflicts: boolean;
  readonly conflictFiles: readonly string[];
  readonly mergeCommitHash?: string;
}

// ============================================================================
// GitHub API Types
// ============================================================================

/**
 * GitHub repository information from API
 */
export interface IGitHubRepository {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly owner: string;
  readonly description: string | null;
  readonly url: string;
  readonly cloneUrl: string;
  readonly private: boolean;
  readonly stars: number;
  readonly forks: number;
  readonly defaultBranch: string;
  readonly permission: 'admin' | 'push' | 'pull';
  readonly updatedAt: Date;
}

/**
 * GitHub pull request information
 */
export interface IGitHubPullRequest {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly mergedAt: Date | null;
}

/**
 * GitHub user profile
 */
export interface IGitHubUser {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly avatarUrl: string;
}

// ============================================================================
// MCP Tool Response Types
// ============================================================================

/**
 * Base response structure for all MCP tools
 */
export interface IMCPToolResponse<TData = unknown> {
  readonly status: 'success' | 'error' | 'quota_exceeded' | 'auth_needed';
  readonly message: string;
  readonly data?: TData;
  readonly suggestions?: readonly string[];
  readonly options?: readonly IMCPOption[];
}

/**
 * Option for user action in MCP response
 */
export interface IMCPOption {
  readonly action: string;
  readonly label: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Severity levels for translated errors
 */
export enum ErrorSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
}

/**
 * Translated error for user-friendly display
 */
export interface ITranslatedError {
  readonly userMessage: string;
  readonly technicalMessage: string;
  readonly suggestions: readonly string[];
  readonly severity: ErrorSeverity;
}

// ============================================================================
// Rate Limiting Types
// ============================================================================

/**
 * User quota check result
 */
export interface IQuotaCheckResult {
  readonly allowed: boolean;
  readonly remaining?: number;
  readonly limit?: number;
  readonly upgradeUrl?: string;
  readonly message?: string;
}

/**
 * Rate limits by tier
 */
export interface ITierLimits {
  readonly commitsPerMonth: number;
  readonly prsPerMonth: number;
  readonly maxRepos: number;
  readonly teamFeatures: boolean;
}

/**
 * Rate limit configuration by tier
 */
export const TIER_LIMITS: Record<UserTier, ITierLimits> = {
  [UserTier.FREE]: {
    commitsPerMonth: 5,
    prsPerMonth: 5,
    maxRepos: 1,
    teamFeatures: false,
  },
  [UserTier.PRO]: {
    commitsPerMonth: Infinity,
    prsPerMonth: Infinity,
    maxRepos: 10,
    teamFeatures: true,
  },
  [UserTier.ENTERPRISE]: {
    commitsPerMonth: Infinity,
    prsPerMonth: Infinity,
    maxRepos: Infinity,
    teamFeatures: true,
  },
} as const;
