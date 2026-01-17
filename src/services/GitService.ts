/**
 * Git Operations Service
 *
 * Provides all local Git operations for the GitFlow MCP Server.
 * Uses simple-git for executing Git commands and integrates with
 * PolicyRejectionHandler for handling push protection violations.
 *
 * AUTHENTICATION:
 * - Uses GitHub OAuth token for HTTPS authentication
 * - Token is embedded in remote URL: https://oauth2:TOKEN@github.com/user/repo.git
 * - Token is NEVER logged in plaintext
 *
 * OPERATIONS:
 * - clone: Clone a repository with authentication
 * - status: Get current repository status
 * - add: Stage files for commit
 * - commit: Create a commit with message
 * - push: Push to remote (with policy rejection handling)
 * - pull: Pull from remote
 * - checkout: Switch branches
 * - createBranch: Create and optionally switch to a new branch
 * - merge: Merge a branch into the current branch
 * - reset: Undo commits (soft/hard/mixed)
 */

import path from 'path';
import os from 'os';
import fs from 'fs';

import { simpleGit, type SimpleGit, type CloneOptions } from 'simple-git';

import { createChildLogger } from '../utils/logger.js';
import { authService } from './AuthService.js';
import {
  policyRejectionHandler,
  type IPolicyViolationResult,
  type ISanitizeResult,
} from './PolicyRejectionHandler.js';
import type {
  IGitStatus,
  IGitCommitResult,
  IGitPushResult,
  IGitPullResult,
  IGitMergeResult,
} from '../types/index.js';

const logger = createChildLogger({ module: 'GitService' });

// ============================================================================
// Types
// ============================================================================

/**
 * Git clone options
 */
export interface ICloneOptions {
  readonly depth?: number;
  readonly branch?: string;
  readonly singleBranch?: boolean;
}

/**
 * Git commit options
 */
export interface ICommitOptions {
  readonly message: string;
  readonly files?: readonly string[];
  readonly amend?: boolean;
  readonly noEdit?: boolean;
}

/**
 * Git push options
 */
export interface IPushOptions {
  readonly force?: boolean;
  readonly forceWithLease?: boolean;
  readonly setUpstream?: boolean;
}

/**
 * Git pull options
 */
export interface IPullOptions {
  readonly rebase?: boolean;
  readonly noRebase?: boolean;
}

/**
 * Git merge options
 */
export interface IMergeOptions {
  readonly strategy?: 'merge' | 'squash' | 'rebase';
  readonly noFf?: boolean;
  readonly message?: string;
}

/**
 * Git reset mode
 */
export type ResetMode = 'soft' | 'mixed' | 'hard';

/**
 * Result of a push operation that was rejected due to policy
 */
export interface IPushRejectionHandled {
  readonly rejected: true;
  readonly violation: IPolicyViolationResult;
  readonly sanitized: ISanitizeResult;
  readonly nextSteps: readonly string[];
}

/**
 * Result of a push operation (success or rejection)
 */
export type PushOperationResult = IGitPushResult | IPushRejectionHandled;

/**
 * Branch information
 */
export interface IBranchInfo {
  readonly name: string;
  readonly current: boolean;
  readonly commit: string;
  readonly label: string;
}

/**
 * Repository configuration for GitService
 */
export interface IRepoConfig {
  readonly userId: string;
  readonly localPath: string;
  readonly remoteUrl?: string;
  readonly userName?: string;
  readonly userEmail?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default base directory for cloned repositories
 */
const DEFAULT_REPOS_BASE_DIR = path.join(os.homedir(), '.gitflow-for-pms', 'repos');

// Note: Git user agent is configured at the repository level, not globally

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build an authenticated remote URL using OAuth token
 *
 * @param remoteUrl - Original remote URL (https://github.com/user/repo.git)
 * @param token - GitHub OAuth access token
 * @returns URL with embedded token for authentication
 */
function buildAuthenticatedUrl(remoteUrl: string, token: string): string {
  try {
    const url = new URL(remoteUrl);
    url.username = 'oauth2';
    url.password = token;
    return url.toString();
  } catch {
    // If URL parsing fails, try regex replacement
    return remoteUrl.replace(/^https:\/\//, `https://oauth2:${token}@`);
  }
}

/**
 * Strip authentication from a URL for safe logging
 *
 * @param url - URL that may contain credentials
 * @returns URL with credentials removed
 */
function sanitizeUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Fallback regex replacement
    return url.replace(/oauth2:[^@]+@/, '');
  }
}

/**
 * Ensure a directory exists, creating it if necessary
 */
function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Generate a local path for a repository
 */
export function generateLocalPath(org: string, repo: string): string {
  return path.join(DEFAULT_REPOS_BASE_DIR, org, repo);
}

// ============================================================================
// GitService Class
// ============================================================================

/**
 * Git Operations Service
 *
 * Manages all local Git operations for a repository.
 * Each instance is associated with a specific user and repository.
 */
export class GitService {
  private readonly userId: string;
  private readonly localPath: string;
  private git: SimpleGit;
  private remoteUrl: string | null = null;

  /**
   * Create a new GitService instance
   *
   * @param config - Repository configuration
   */
  constructor(config: IRepoConfig) {
    this.userId = config.userId;
    this.localPath = config.localPath;

    // Initialize simple-git with the local path
    this.git = simpleGit(this.localPath);

    if (config.remoteUrl) {
      this.remoteUrl = config.remoteUrl;
    }

    logger.debug({ userId: this.userId, localPath: this.localPath }, 'GitService initialized');
  }

  // ==========================================================================
  // Static Factory Methods
  // ==========================================================================

  /**
   * Create a GitService for an existing repository
   *
   * @param userId - User ID
   * @param localPath - Path to the local repository
   * @returns GitService instance
   */
  public static forExistingRepo(userId: string, localPath: string): GitService {
    return new GitService({ userId, localPath });
  }

  /**
   * Create a GitService for cloning a new repository
   *
   * @param userId - User ID
   * @param org - GitHub organization or username
   * @param repo - Repository name
   * @returns GitService instance with generated local path
   */
  public static forNewClone(userId: string, org: string, repo: string): GitService {
    const localPath = generateLocalPath(org, repo);
    return new GitService({ userId, localPath });
  }

  // ==========================================================================
  // Repository Information
  // ==========================================================================

  /**
   * Get the local repository path
   */
  public getLocalPath(): string {
    return this.localPath;
  }

  /**
   * Get the user ID
   */
  public getUserId(): string {
    return this.userId;
  }

  /**
   * Check if the repository exists locally
   */
  public isCloned(): boolean {
    const gitDir = path.join(this.localPath, '.git');
    return fs.existsSync(gitDir);
  }

  // ==========================================================================
  // Clone Operation
  // ==========================================================================

  /**
   * Clone a repository
   *
   * @param remoteUrl - Repository URL (https://github.com/user/repo.git)
   * @param options - Clone options
   * @returns Local path where repository was cloned
   */
  public async clone(remoteUrl: string, options?: ICloneOptions): Promise<string> {
    // Get authentication token
    const token = await authService.getAccessToken(this.userId);
    if (!token) {
      throw new Error('Not authenticated. Please authenticate with GitHub first.');
    }

    // Build authenticated URL
    const authUrl = buildAuthenticatedUrl(remoteUrl, token);
    this.remoteUrl = remoteUrl;

    // Ensure parent directory exists
    const parentDir = path.dirname(this.localPath);
    ensureDirectory(parentDir);

    // Check if already cloned
    if (this.isCloned()) {
      logger.info({ localPath: this.localPath }, 'Repository already cloned');
      return this.localPath;
    }

    // Build clone options
    const cloneOpts: CloneOptions = {};
    if (options?.depth) {
      cloneOpts['--depth'] = options.depth;
    }
    if (options?.branch) {
      cloneOpts['--branch'] = options.branch;
    }
    if (options?.singleBranch) {
      cloneOpts['--single-branch'] = null;
    }

    logger.info(
      { remoteUrl: sanitizeUrlForLogging(remoteUrl), localPath: this.localPath },
      'Cloning repository'
    );

    try {
      // Use a fresh git instance for cloning (not bound to localPath yet)
      const git = simpleGit();
      await git.clone(authUrl, this.localPath, cloneOpts);

      // Re-initialize git instance for the cloned repo
      this.git = simpleGit(this.localPath);

      // Configure user for the repository
      await this.configureUser();

      logger.info(
        { remoteUrl: sanitizeUrlForLogging(remoteUrl), localPath: this.localPath },
        'Repository cloned successfully'
      );

      return this.localPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Sanitize error message to remove any tokens
      const sanitizedError = errorMessage.replace(/oauth2:[^@]+@/g, '');

      logger.error(
        { remoteUrl: sanitizeUrlForLogging(remoteUrl), error: sanitizedError },
        'Failed to clone repository'
      );

      throw new Error(`Failed to clone repository: ${sanitizedError}`);
    }
  }

  /**
   * Configure user name and email for the repository
   */
  private async configureUser(): Promise<void> {
    try {
      // Get user info from auth service or use defaults
      // For MVP, we'll set a default configuration
      await this.git.addConfig('user.name', 'GitFlow for PMs');
      await this.git.addConfig('user.email', 'gitflow-bot@users.noreply.github.com');

      logger.debug({ localPath: this.localPath }, 'Configured git user for repository');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn({ error: errorMessage }, 'Failed to configure git user');
    }
  }

  // ==========================================================================
  // Status Operation
  // ==========================================================================

  /**
   * Get the current repository status
   *
   * @returns Repository status information
   */
  public async status(): Promise<IGitStatus> {
    try {
      const status = await this.git.status();

      // Get ahead/behind counts
      let ahead = 0;
      let behind = 0;

      if (status.tracking) {
        ahead = status.ahead;
        behind = status.behind;
      }

      return {
        currentBranch: status.current ?? 'unknown',
        modifiedFiles: status.modified,
        stagedFiles: status.staged,
        untrackedFiles: status.not_added,
        isClean: status.isClean(),
        ahead,
        behind,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, error: errorMessage }, 'Failed to get status');
      throw new Error(`Failed to get repository status: ${errorMessage}`);
    }
  }

  // ==========================================================================
  // Staging Operations
  // ==========================================================================

  /**
   * Stage files for commit
   *
   * @param files - Files to stage (defaults to all)
   */
  public async add(files: readonly string[] | '.' = '.'): Promise<void> {
    try {
      if (files === '.') {
        await this.git.add('.');
      } else {
        await this.git.add(files as string[]);
      }

      logger.debug(
        { localPath: this.localPath, files: files === '.' ? 'all' : files.length },
        'Staged files'
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, error: errorMessage }, 'Failed to stage files');
      throw new Error(`Failed to stage files: ${errorMessage}`);
    }
  }

  /**
   * Unstage files
   *
   * @param files - Files to unstage
   */
  public async unstage(files: readonly string[]): Promise<void> {
    try {
      await this.git.reset(['HEAD', '--', ...files]);

      logger.debug({ localPath: this.localPath, files: files.length }, 'Unstaged files');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, error: errorMessage }, 'Failed to unstage files');
      throw new Error(`Failed to unstage files: ${errorMessage}`);
    }
  }

  // ==========================================================================
  // Commit Operations
  // ==========================================================================

  /**
   * Create a commit
   *
   * @param options - Commit options
   * @returns Commit result with hash and stats
   */
  public async commit(options: ICommitOptions): Promise<IGitCommitResult> {
    try {
      // Stage files if specified
      if (options.files && options.files.length > 0) {
        await this.add(options.files);
      }

      // Build commit options
      const commitOpts: string[] = [];

      if (options.amend) {
        commitOpts.push('--amend');
      }

      if (options.noEdit) {
        commitOpts.push('--no-edit');
      }

      // Create commit
      let result;
      if (options.amend && options.noEdit) {
        result = await this.git.commit([], commitOpts);
      } else {
        result = await this.git.commit(options.message, commitOpts);
      }

      // Parse result - simple-git returns summary info
      const commitHash = result.commit || 'unknown';
      const filesChanged = result.summary?.changes ?? 0;
      const insertions = result.summary?.insertions ?? 0;
      const deletions = result.summary?.deletions ?? 0;

      logger.info(
        { localPath: this.localPath, commitHash, filesChanged },
        'Created commit'
      );

      return {
        commitHash,
        message: options.message,
        filesChanged,
        insertions,
        deletions,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, error: errorMessage }, 'Failed to commit');

      // Check for common commit errors
      if (errorMessage.includes('nothing to commit')) {
        throw new Error('No changes to commit. The working directory is clean.');
      }

      throw new Error(`Failed to commit: ${errorMessage}`);
    }
  }

  /**
   * Amend the last commit with current staged changes
   *
   * @param message - Optional new commit message
   * @returns Commit result
   */
  public async amendCommit(message?: string): Promise<IGitCommitResult> {
    return this.commit({
      message: message ?? '',
      amend: true,
      noEdit: !message,
    });
  }

  // ==========================================================================
  // Push Operations
  // ==========================================================================

  /**
   * Push to remote
   *
   * This method handles push protection violations (GH009/GH013) by:
   * 1. Detecting the error
   * 2. Parsing violation details
   * 3. Sanitizing commit history
   * 4. Returning instructions for the PM to fix and retry
   *
   * @param branch - Branch to push
   * @param options - Push options
   * @returns Push result or rejection handling info
   */
  public async push(branch: string, options?: IPushOptions): Promise<PushOperationResult> {
    // Get authentication token
    const token = await authService.getAccessToken(this.userId);
    if (!token) {
      throw new Error('Not authenticated. Please authenticate with GitHub first.');
    }

    try {
      // Get current remote URL
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');

      if (!origin?.refs?.push) {
        throw new Error('No remote "origin" configured for this repository.');
      }

      // Build authenticated remote URL
      const authUrl = buildAuthenticatedUrl(origin.refs.push, token);

      // Temporarily set remote URL with auth
      await this.git.remote(['set-url', 'origin', authUrl]);

      try {
        // Build push options
        const pushArgs: string[] = ['origin', branch];

        if (options?.forceWithLease) {
          pushArgs.push('--force-with-lease');
        } else if (options?.force) {
          pushArgs.push('--force');
        }

        if (options?.setUpstream) {
          pushArgs.push('--set-upstream');
        }

        logger.info(
          { localPath: this.localPath, branch, force: options?.force ?? false },
          'Pushing to remote'
        );

        await this.git.push(pushArgs);

        logger.info({ localPath: this.localPath, branch }, 'Push successful');

        return {
          success: true,
          remoteUrl: sanitizeUrlForLogging(origin.refs.push),
          branch,
        };
      } finally {
        // Always restore original remote URL (without token)
        const cleanUrl = sanitizeUrlForLogging(origin.refs.push);
        await this.git.remote(['set-url', 'origin', cleanUrl]).catch(() => {
          // Ignore errors during cleanup
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sanitizedError = errorMessage.replace(/oauth2:[^@]+@/g, '');

      logger.warn({ localPath: this.localPath, branch, error: sanitizedError }, 'Push failed');

      // Check if this is a policy rejection
      if (policyRejectionHandler.isPolicyViolation(sanitizedError)) {
        logger.info({ localPath: this.localPath }, 'Policy violation detected, initiating recovery');

        const result = await policyRejectionHandler.handlePushRejection(
          this.localPath,
          sanitizedError
        );

        return {
          rejected: true,
          ...result,
        };
      }

      // Handle other push errors
      if (sanitizedError.includes('would be overwritten by merge')) {
        throw new Error('You have local changes that would be overwritten. Save or discard them first.');
      }

      if (sanitizedError.includes('non-fast-forward') || sanitizedError.includes('behind')) {
        throw new Error('Your branch is behind the remote. Pull the latest changes first.');
      }

      if (sanitizedError.includes('permission denied') || sanitizedError.includes('403')) {
        throw new Error('Permission denied. Check that you have push access to this repository.');
      }

      throw new Error(`Push failed: ${sanitizedError}`);
    }
  }

  /**
   * Retry push after fixing a policy violation
   *
   * @param branch - Branch to push
   * @param commitMessage - Message for the new commit
   * @returns Push result
   */
  public async retryPushAfterFix(branch: string, commitMessage: string): Promise<IGitPushResult> {
    // Re-commit the changes
    const commitResult = await policyRejectionHandler.recommit(this.localPath, commitMessage);

    if (!commitResult.success) {
      throw new Error(commitResult.error ?? 'Failed to create commit');
    }

    // Push with force-with-lease
    const result = await this.push(branch, { forceWithLease: true });

    // Check if it was rejected again
    if ('rejected' in result && result.rejected) {
      throw new Error('Push was rejected again. Please make sure all secrets have been removed.');
    }

    return result as IGitPushResult;
  }

  // ==========================================================================
  // Pull Operations
  // ==========================================================================

  /**
   * Pull from remote
   *
   * @param options - Pull options
   * @returns Pull result with conflict info
   */
  public async pull(options?: IPullOptions): Promise<IGitPullResult> {
    // Get authentication token
    const token = await authService.getAccessToken(this.userId);
    if (!token) {
      throw new Error('Not authenticated. Please authenticate with GitHub first.');
    }

    try {
      // Get current remote URL
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');

      if (!origin?.refs?.fetch) {
        throw new Error('No remote "origin" configured for this repository.');
      }

      // Build authenticated remote URL
      const authUrl = buildAuthenticatedUrl(origin.refs.fetch, token);

      // Temporarily set remote URL with auth
      await this.git.remote(['set-url', 'origin', authUrl]);

      try {
        // Build pull options
        const pullOpts: string[] = [];

        if (options?.rebase) {
          pullOpts.push('--rebase');
        } else if (options?.noRebase) {
          pullOpts.push('--no-rebase');
        }

        logger.info({ localPath: this.localPath }, 'Pulling from remote');

        // Get commit count before pull
        const beforeLog = await this.git.log({ maxCount: 1 });
        const beforeHash = beforeLog.latest?.hash ?? '';

        // Perform pull
        await this.git.pull('origin', undefined, pullOpts);

        // Get commit count after pull
        const afterLog = await this.git.log({ maxCount: 50 }); // Check last 50 commits
        let newCommits = 0;
        if (beforeHash) {
          for (const commit of afterLog.all) {
            if (commit.hash === beforeHash) break;
            newCommits++;
          }
        }

        logger.info({ localPath: this.localPath, newCommits }, 'Pull successful');

        return {
          success: true,
          newCommits,
          hasConflicts: false,
          conflictFiles: [],
        };
      } finally {
        // Restore original remote URL
        const cleanUrl = sanitizeUrlForLogging(origin.refs.fetch);
        await this.git.remote(['set-url', 'origin', cleanUrl]).catch(() => {
          // Ignore cleanup errors
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sanitizedError = errorMessage.replace(/oauth2:[^@]+@/g, '');

      logger.warn({ localPath: this.localPath, error: sanitizedError }, 'Pull failed');

      // Check for merge conflicts
      if (sanitizedError.includes('CONFLICT') || sanitizedError.includes('Merge conflict')) {
        // Get list of conflicted files
        const status = await this.git.status();
        const conflictFiles = status.conflicted;

        return {
          success: false,
          newCommits: 0,
          hasConflicts: true,
          conflictFiles,
        };
      }

      throw new Error(`Pull failed: ${sanitizedError}`);
    }
  }

  // ==========================================================================
  // Branch Operations
  // ==========================================================================

  /**
   * Checkout a branch
   *
   * @param branch - Branch name to checkout
   */
  public async checkout(branch: string): Promise<void> {
    try {
      await this.git.checkout(branch);
      logger.info({ localPath: this.localPath, branch }, 'Checked out branch');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, branch, error: errorMessage }, 'Checkout failed');

      if (errorMessage.includes('would be overwritten')) {
        throw new Error('You have uncommitted changes that would be overwritten. Save or discard them first.');
      }

      if (errorMessage.includes('pathspec') || errorMessage.includes('did not match')) {
        throw new Error(`Branch '${branch}' does not exist.`);
      }

      throw new Error(`Failed to checkout branch: ${errorMessage}`);
    }
  }

  /**
   * Create a new branch
   *
   * @param branchName - Name for the new branch
   * @param fromBranch - Optional base branch (defaults to current)
   * @param checkout - Whether to checkout the new branch (default: true)
   */
  public async createBranch(
    branchName: string,
    fromBranch?: string,
    checkout: boolean = true
  ): Promise<void> {
    try {
      // If fromBranch specified, checkout it first
      if (fromBranch) {
        await this.checkout(fromBranch);
        await this.pull().catch(() => {
          // Ignore pull errors when creating branch
        });
      }

      // Create the branch
      if (checkout) {
        await this.git.checkoutLocalBranch(branchName);
      } else {
        await this.git.branch([branchName]);
      }

      logger.info(
        { localPath: this.localPath, branchName, fromBranch, checkout },
        'Created new branch'
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { localPath: this.localPath, branchName, error: errorMessage },
        'Failed to create branch'
      );

      if (errorMessage.includes('already exists')) {
        throw new Error(`Branch '${branchName}' already exists. Try a different name.`);
      }

      throw new Error(`Failed to create branch: ${errorMessage}`);
    }
  }

  /**
   * Delete a branch
   *
   * @param branchName - Branch to delete
   * @param force - Force delete even if not fully merged
   */
  public async deleteBranch(branchName: string, force: boolean = false): Promise<void> {
    try {
      const deleteOpts = force ? ['-D', branchName] : ['-d', branchName];
      await this.git.branch(deleteOpts);
      logger.info({ localPath: this.localPath, branchName, force }, 'Deleted branch');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { localPath: this.localPath, branchName, error: errorMessage },
        'Failed to delete branch'
      );

      if (errorMessage.includes('not fully merged')) {
        throw new Error(
          `Branch '${branchName}' has unmerged changes. Use force delete if you're sure.`
        );
      }

      throw new Error(`Failed to delete branch: ${errorMessage}`);
    }
  }

  /**
   * Get list of branches
   *
   * @returns List of branch information
   */
  public async getBranches(): Promise<readonly IBranchInfo[]> {
    try {
      const branchSummary = await this.git.branch(['-v']);

      return Object.entries(branchSummary.branches).map(([name, data]) => ({
        name,
        current: data.current,
        commit: data.commit,
        label: data.label,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, error: errorMessage }, 'Failed to get branches');
      throw new Error(`Failed to get branches: ${errorMessage}`);
    }
  }

  /**
   * Get the current branch name
   *
   * @returns Current branch name
   */
  public async getCurrentBranch(): Promise<string> {
    try {
      const branchSummary = await this.git.branch();
      return branchSummary.current;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, error: errorMessage }, 'Failed to get current branch');
      throw new Error(`Failed to get current branch: ${errorMessage}`);
    }
  }

  // ==========================================================================
  // Merge Operations
  // ==========================================================================

  /**
   * Merge a branch into the current branch
   *
   * @param branch - Branch to merge
   * @param options - Merge options
   * @returns Merge result with conflict info
   */
  public async merge(branch: string, options?: IMergeOptions): Promise<IGitMergeResult> {
    try {
      const mergeArgs: string[] = [branch];

      if (options?.strategy === 'squash') {
        mergeArgs.push('--squash');
      }

      if (options?.noFf) {
        mergeArgs.push('--no-ff');
      }

      if (options?.message) {
        mergeArgs.push('-m', options.message);
      }

      logger.info(
        { localPath: this.localPath, branch, strategy: options?.strategy ?? 'merge' },
        'Merging branch'
      );

      await this.git.merge(mergeArgs);

      // Get the merge commit hash
      const log = await this.git.log({ maxCount: 1 });
      const mergeCommitHash = log.latest?.hash;

      logger.info({ localPath: this.localPath, branch, mergeCommitHash }, 'Merge successful');

      const result: IGitMergeResult = {
        success: true,
        hasConflicts: false,
        conflictFiles: [],
      };

      // Only include mergeCommitHash if we have one (satisfies exactOptionalPropertyTypes)
      if (mergeCommitHash) {
        return { ...result, mergeCommitHash };
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn({ localPath: this.localPath, branch, error: errorMessage }, 'Merge failed');

      // Check for merge conflicts
      if (errorMessage.includes('CONFLICT') || errorMessage.includes('Merge conflict')) {
        const status = await this.git.status();
        const conflictFiles = status.conflicted;

        return {
          success: false,
          hasConflicts: true,
          conflictFiles,
        };
      }

      throw new Error(`Merge failed: ${errorMessage}`);
    }
  }

  /**
   * Abort a merge in progress
   */
  public async abortMerge(): Promise<void> {
    try {
      await this.git.merge(['--abort']);
      logger.info({ localPath: this.localPath }, 'Merge aborted');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, error: errorMessage }, 'Failed to abort merge');
      throw new Error(`Failed to abort merge: ${errorMessage}`);
    }
  }

  // ==========================================================================
  // Reset Operations
  // ==========================================================================

  /**
   * Reset the repository to a previous state
   *
   * @param mode - Reset mode (soft, mixed, hard)
   * @param ref - Reference to reset to (default: HEAD~1)
   */
  public async reset(mode: ResetMode = 'soft', ref: string = 'HEAD~1'): Promise<void> {
    try {
      await this.git.reset([`--${mode}`, ref]);
      logger.info({ localPath: this.localPath, mode, ref }, 'Reset successful');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, mode, ref, error: errorMessage }, 'Reset failed');
      throw new Error(`Reset failed: ${errorMessage}`);
    }
  }

  /**
   * Soft reset - undo commit but keep changes staged
   */
  public async softReset(commits: number = 1): Promise<void> {
    return this.reset('soft', `HEAD~${commits}`);
  }

  /**
   * Hard reset - undo commit and discard changes
   */
  public async hardReset(commits: number = 1): Promise<void> {
    return this.reset('hard', `HEAD~${commits}`);
  }

  // ==========================================================================
  // Utility Operations
  // ==========================================================================

  /**
   * Fetch from remote
   */
  public async fetch(): Promise<void> {
    // Get authentication token
    const token = await authService.getAccessToken(this.userId);
    if (!token) {
      throw new Error('Not authenticated. Please authenticate with GitHub first.');
    }

    try {
      // Get current remote URL
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');

      if (!origin?.refs?.fetch) {
        throw new Error('No remote "origin" configured for this repository.');
      }

      // Build authenticated remote URL
      const authUrl = buildAuthenticatedUrl(origin.refs.fetch, token);

      // Temporarily set remote URL with auth
      await this.git.remote(['set-url', 'origin', authUrl]);

      try {
        await this.git.fetch(['origin', '--prune']);
        logger.debug({ localPath: this.localPath }, 'Fetched from remote');
      } finally {
        // Restore original remote URL
        const cleanUrl = sanitizeUrlForLogging(origin.refs.fetch);
        await this.git.remote(['set-url', 'origin', cleanUrl]).catch(() => {});
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sanitizedError = errorMessage.replace(/oauth2:[^@]+@/g, '');
      logger.error({ localPath: this.localPath, error: sanitizedError }, 'Fetch failed');
      throw new Error(`Fetch failed: ${sanitizedError}`);
    }
  }

  /**
   * Get commit log
   *
   * @param maxCount - Maximum number of commits to return
   * @returns List of commits
   */
  public async getLog(maxCount: number = 10): Promise<
    readonly {
      readonly hash: string;
      readonly message: string;
      readonly date: string;
      readonly author: string;
    }[]
  > {
    try {
      const log = await this.git.log({ maxCount });

      return log.all.map((commit) => ({
        hash: commit.hash,
        message: commit.message,
        date: commit.date,
        author: commit.author_name,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, error: errorMessage }, 'Failed to get log');
      throw new Error(`Failed to get commit log: ${errorMessage}`);
    }
  }

  /**
   * Check if there are uncommitted changes
   */
  public async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.status();
    return !status.isClean;
  }

  /**
   * Get the remote URL
   */
  public async getRemoteUrl(): Promise<string | null> {
    // Return cached URL if available
    if (this.remoteUrl) {
      return this.remoteUrl;
    }

    // Otherwise fetch from git
    try {
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');
      const url = origin?.refs?.push ?? null;
      if (url) {
        this.remoteUrl = url;
      }
      return url;
    } catch {
      return null;
    }
  }

  /**
   * Clean up untracked files
   *
   * @param force - Force clean (required)
   * @param directories - Also clean directories
   */
  public async clean(force: boolean = true, directories: boolean = false): Promise<void> {
    try {
      const cleanOpts: string[] = [];
      if (force) cleanOpts.push('-f');
      if (directories) cleanOpts.push('-d');

      await this.git.clean(cleanOpts);
      logger.info({ localPath: this.localPath }, 'Cleaned untracked files');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath: this.localPath, error: errorMessage }, 'Clean failed');
      throw new Error(`Clean failed: ${errorMessage}`);
    }
  }
}

/**
 * Create a GitService instance for a user and repository
 */
export function createGitService(userId: string, localPath: string): GitService {
  return GitService.forExistingRepo(userId, localPath);
}
