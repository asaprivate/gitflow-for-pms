/**
 * GitHub API Service
 *
 * Provides all GitHub REST API operations for the GitFlow MCP Server.
 * Uses @octokit/rest for type-safe API interactions.
 *
 * OPERATIONS:
 * - User profile and authentication status
 * - Repository listing and details
 * - Pull request creation, status, and merging
 * - Organization access
 *
 * AUTHENTICATION:
 * - Uses OAuth access token from AuthService
 * - Token is passed to Octokit constructor
 * - Token is NEVER logged in plaintext
 *
 * RATE LIMITING:
 * - GitHub API has rate limits (5000 requests/hour for authenticated users)
 * - Rate limit info is available via getRateLimit()
 * - Service logs warnings when approaching limits
 *
 * ERROR HANDLING:
 * - All Octokit errors are wrapped in user-friendly messages
 * - 401: Authentication failure
 * - 403: Permission denied or rate limited
 * - 404: Resource not found
 * - 422: Validation failure
 */

import { Octokit } from '@octokit/rest';

import { createChildLogger } from '../utils/logger.js';
import type { IGitHubRepository, IGitHubPullRequest, IGitHubUser } from '../types/index.js';

const logger = createChildLogger({ module: 'GitHubAPIService' });

// ============================================================================
// Types
// ============================================================================

/**
 * GitHub API error response structure
 */
interface IGitHubAPIError {
  readonly status: number;
  readonly message: string;
  readonly documentation_url?: string;
  readonly errors?: ReadonlyArray<{
    readonly resource: string;
    readonly code: string;
    readonly field: string;
    readonly message?: string;
  }>;
}

/**
 * Rate limit information
 */
export interface IRateLimitInfo {
  readonly limit: number;
  readonly remaining: number;
  readonly reset: Date;
  readonly used: number;
}

/**
 * Repository listing options
 */
export interface IListReposOptions {
  readonly page?: number;
  readonly perPage?: number;
  readonly sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  readonly direction?: 'asc' | 'desc';
  readonly type?: 'all' | 'owner' | 'public' | 'private' | 'member';
  readonly affiliation?: string; // 'owner,collaborator,organization_member'
}

/**
 * Pull request creation options
 */
export interface ICreatePullRequestOptions {
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
  readonly head: string; // Branch containing changes
  readonly base?: string; // Branch to merge into (default: main)
  readonly body?: string;
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

/**
 * Pull request merge options
 */
export interface IMergePullRequestOptions {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly commitTitle?: string;
  readonly commitMessage?: string;
  readonly mergeMethod?: 'merge' | 'squash' | 'rebase';
}

/**
 * Pull request status details
 */
export interface IPullRequestStatus {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly mergeable: boolean | null;
  readonly mergeableState: string;
  readonly rebaseable: boolean | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly url: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
  readonly mergedAt: Date | null;
  readonly mergedBy: string | null;
  readonly reviewDecision: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

/**
 * Organization info
 */
export interface IOrganization {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly avatarUrl: string;
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * GitHub API Error class with user-friendly messaging
 */
export class GitHubAPIError extends Error {
  public readonly status: number;
  public readonly userMessage: string;
  public readonly technicalMessage: string;
  public readonly isRateLimited: boolean;
  public readonly isAuthError: boolean;
  public readonly isNotFound: boolean;
  public readonly isValidationError: boolean;

  constructor(status: number, message: string, userMessage: string) {
    super(message);
    this.name = 'GitHubAPIError';
    this.status = status;
    this.technicalMessage = message;
    this.userMessage = userMessage;
    this.isRateLimited = status === 403 && message.toLowerCase().includes('rate limit');
    this.isAuthError = status === 401;
    this.isNotFound = status === 404;
    this.isValidationError = status === 422;
  }
}

/**
 * Wrap Octokit errors in user-friendly GitHubAPIError
 */
function wrapError(error: unknown): GitHubAPIError {
  // Handle Octokit errors
  if (error && typeof error === 'object' && 'status' in error) {
    const octokitError = error as { status: number; message: string; response?: { data?: IGitHubAPIError } };
    const status = octokitError.status;
    const message = octokitError.response?.data?.message ?? octokitError.message;

    // Map status codes to user-friendly messages
    switch (status) {
      case 401:
        return new GitHubAPIError(
          status,
          message,
          'GitHub authentication failed. Please re-authenticate with GitHub.'
        );

      case 403:
        if (message.toLowerCase().includes('rate limit')) {
          return new GitHubAPIError(
            status,
            message,
            'GitHub API rate limit exceeded. Please wait a few minutes and try again.'
          );
        }
        if (message.toLowerCase().includes('secondary rate limit')) {
          return new GitHubAPIError(
            status,
            message,
            'Too many requests to GitHub. Please slow down and try again in a minute.'
          );
        }
        return new GitHubAPIError(
          status,
          message,
          "You don't have permission to perform this action. Check your repository access."
        );

      case 404:
        return new GitHubAPIError(
          status,
          message,
          'Repository or resource not found. Check that it exists and you have access.'
        );

      case 422:
        // Validation errors - try to provide specific message
        const validationErrors = octokitError.response?.data?.errors;
        if (validationErrors && validationErrors.length > 0) {
          const errorMessages = validationErrors
            .map((e) => e.message ?? `${e.field}: ${e.code}`)
            .join('; ');
          return new GitHubAPIError(
            status,
            message,
            `Invalid request: ${errorMessages}`
          );
        }
        return new GitHubAPIError(
          status,
          message,
          'Invalid request. Please check your input and try again.'
        );

      case 409:
        return new GitHubAPIError(
          status,
          message,
          'Conflict detected. The resource may have been modified by someone else.'
        );

      case 500:
      case 502:
      case 503:
        return new GitHubAPIError(
          status,
          message,
          'GitHub is experiencing issues. Please try again in a few minutes.'
        );

      default:
        return new GitHubAPIError(
          status,
          message,
          `GitHub API error (${status}): ${message}`
        );
    }
  }

  // Handle other errors
  const errorMessage = error instanceof Error ? error.message : String(error);
  return new GitHubAPIError(0, errorMessage, `Unexpected error: ${errorMessage}`);
}

// ============================================================================
// GitHub API Service
// ============================================================================

/**
 * GitHub API Service
 *
 * Provides type-safe access to GitHub REST API operations.
 */
export class GitHubAPIService {
  private readonly octokit: Octokit;
  private readonly userAgent: string = 'GitFlow-for-PMs/1.0';

  /**
   * Create a new GitHubAPIService instance
   *
   * @param accessToken - GitHub OAuth access token
   */
  constructor(accessToken: string) {
    this.octokit = new Octokit({
      auth: accessToken,
      userAgent: this.userAgent,
      // Log rate limit warnings
      log: {
        debug: () => {},
        info: () => {},
        warn: (msg) => logger.warn({ msg }, 'Octokit warning'),
        error: (msg) => logger.error({ msg }, 'Octokit error'),
      },
    });

    logger.debug('GitHubAPIService initialized');
  }

  // ==========================================================================
  // User Operations
  // ==========================================================================

  /**
   * Get the authenticated user's profile
   *
   * @returns User profile information
   */
  public async getUserProfile(): Promise<IGitHubUser> {
    try {
      logger.debug('Fetching authenticated user profile');

      const { data } = await this.octokit.users.getAuthenticated();

      logger.debug({ userId: data.id, username: data.login }, 'Fetched user profile');

      return {
        id: data.id,
        login: data.login,
        name: data.name ?? null,
        email: data.email ?? null,
        avatarUrl: data.avatar_url,
      };
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * Get a user's organizations
   *
   * @returns List of organizations the user belongs to
   */
  public async getUserOrganizations(): Promise<readonly IOrganization[]> {
    try {
      logger.debug('Fetching user organizations');

      const { data } = await this.octokit.orgs.listForAuthenticatedUser();

      return data.map((org) => ({
        id: org.id,
        login: org.login,
        name: org.login, // listForAuthenticatedUser doesn't return full name
        description: org.description ?? null,
        avatarUrl: org.avatar_url,
      }));
    } catch (error) {
      throw wrapError(error);
    }
  }

  // ==========================================================================
  // Repository Operations
  // ==========================================================================

  /**
   * List repositories the user has access to
   *
   * @param options - Listing options (pagination, sort, filter)
   * @returns List of repositories
   */
  public async listRepositories(options: IListReposOptions = {}): Promise<readonly IGitHubRepository[]> {
    try {
      const {
        page = 1,
        perPage = 30,
        sort = 'updated',
        direction = 'desc',
        affiliation = 'owner,collaborator,organization_member',
      } = options;

      logger.debug({ page, perPage, sort }, 'Listing repositories');

      const { data } = await this.octokit.repos.listForAuthenticatedUser({
        page,
        per_page: perPage,
        sort,
        direction,
        affiliation,
      });

      const repos = data.map((repo) => this.mapRepository(repo));

      logger.debug({ count: repos.length, page }, 'Fetched repositories');

      return repos;
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * List repositories for a specific organization
   *
   * @param org - Organization login name
   * @param options - Listing options
   * @returns List of organization repositories
   */
  public async listOrganizationRepositories(
    org: string,
    options: IListReposOptions = {}
  ): Promise<readonly IGitHubRepository[]> {
    try {
      const { page = 1, perPage = 30, sort = 'updated' } = options;

      logger.debug({ org, page, perPage }, 'Listing organization repositories');

      const { data } = await this.octokit.repos.listForOrg({
        org,
        page,
        per_page: perPage,
        sort: sort as 'created' | 'updated' | 'pushed' | 'full_name',
      });

      const repos = data.map((repo) => this.mapRepository(repo));

      logger.debug({ org, count: repos.length }, 'Fetched organization repositories');

      return repos;
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * Get details for a specific repository
   *
   * @param owner - Repository owner (user or org)
   * @param repo - Repository name
   * @returns Repository details
   */
  public async getRepoDetails(owner: string, repo: string): Promise<IGitHubRepository> {
    try {
      logger.debug({ owner, repo }, 'Fetching repository details');

      const { data } = await this.octokit.repos.get({ owner, repo });

      const repository = this.mapRepository(data);

      logger.debug({ owner, repo, id: repository.id }, 'Fetched repository details');

      return repository;
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * Get the default branch for a repository
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns Default branch name
   */
  public async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const repoDetails = await this.getRepoDetails(owner, repo);
    return repoDetails.defaultBranch;
  }

  /**
   * Check if the user has push access to a repository
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns true if user can push
   */
  public async canPush(owner: string, repo: string): Promise<boolean> {
    try {
      const repoDetails = await this.getRepoDetails(owner, repo);
      return repoDetails.permission === 'admin' || repoDetails.permission === 'push';
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Pull Request Operations
  // ==========================================================================

  /**
   * Create a pull request
   *
   * @param options - PR creation options
   * @returns Created pull request
   */
  public async createPullRequest(options: ICreatePullRequestOptions): Promise<IGitHubPullRequest> {
    try {
      const {
        owner,
        repo,
        title,
        head,
        base,
        body = '',
        draft = false,
        maintainerCanModify = true,
      } = options;

      // Get default branch if base not specified
      const baseBranch = base ?? (await this.getDefaultBranch(owner, repo));

      logger.info({ owner, repo, head, base: baseBranch, draft }, 'Creating pull request');

      const { data } = await this.octokit.pulls.create({
        owner,
        repo,
        title,
        head,
        base: baseBranch,
        body,
        draft,
        maintainer_can_modify: maintainerCanModify,
      });

      const pr = this.mapPullRequest(data);

      logger.info({ owner, repo, prNumber: pr.number, url: pr.url }, 'Pull request created');

      return pr;
    } catch (error) {
      const wrapped = wrapError(error);

      // Provide more specific error messages for common PR creation issues
      if (wrapped.status === 422) {
        const message = wrapped.technicalMessage.toLowerCase();
        if (message.includes('no commits between')) {
          throw new GitHubAPIError(
            422,
            wrapped.technicalMessage,
            'No changes to create a PR. Make sure you have commits on your branch that differ from the base branch.'
          );
        }
        if (message.includes('a pull request already exists')) {
          throw new GitHubAPIError(
            422,
            wrapped.technicalMessage,
            'A pull request already exists for this branch. Check your open PRs.'
          );
        }
      }

      throw wrapped;
    }
  }

  /**
   * Get pull request status and details
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param pullNumber - PR number
   * @returns Pull request status
   */
  public async getPullRequestStatus(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<IPullRequestStatus> {
    try {
      logger.debug({ owner, repo, pullNumber }, 'Fetching pull request status');

      const { data } = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const status: IPullRequestStatus = {
        number: data.number,
        title: data.title,
        state: data.state as 'open' | 'closed',
        merged: data.merged,
        mergeable: data.mergeable,
        mergeableState: data.mergeable_state,
        rebaseable: data.rebaseable ?? null,
        headBranch: data.head.ref,
        baseBranch: data.base.ref,
        url: data.html_url,
        createdAt: new Date(data.created_at),
        updatedAt: new Date(data.updated_at),
        closedAt: data.closed_at ? new Date(data.closed_at) : null,
        mergedAt: data.merged_at ? new Date(data.merged_at) : null,
        mergedBy: data.merged_by?.login ?? null,
        reviewDecision: null, // Would require GraphQL API
        additions: data.additions,
        deletions: data.deletions,
        changedFiles: data.changed_files,
      };

      logger.debug(
        { owner, repo, pullNumber, state: status.state, merged: status.merged },
        'Fetched pull request status'
      );

      return status;
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * List pull requests for a repository
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param state - Filter by state
   * @returns List of pull requests
   */
  public async listPullRequests(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<readonly IGitHubPullRequest[]> {
    try {
      logger.debug({ owner, repo, state }, 'Listing pull requests');

      const { data } = await this.octokit.pulls.list({
        owner,
        repo,
        state,
        per_page: 30,
      });

      const prs = data.map((pr) => this.mapPullRequest(pr));

      logger.debug({ owner, repo, count: prs.length }, 'Fetched pull requests');

      return prs;
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * Merge a pull request
   *
   * @param options - Merge options
   * @returns Merge result
   */
  public async mergePullRequest(options: IMergePullRequestOptions): Promise<{
    readonly merged: boolean;
    readonly sha: string;
    readonly message: string;
  }> {
    try {
      const {
        owner,
        repo,
        pullNumber,
        commitTitle,
        commitMessage,
        mergeMethod = 'squash',
      } = options;

      logger.info({ owner, repo, pullNumber, mergeMethod }, 'Merging pull request');

      // Build merge params, only including optional fields if defined
      const mergeParams: {
        owner: string;
        repo: string;
        pull_number: number;
        merge_method: 'merge' | 'squash' | 'rebase';
        commit_title?: string;
        commit_message?: string;
      } = {
        owner,
        repo,
        pull_number: pullNumber,
        merge_method: mergeMethod,
      };

      if (commitTitle) {
        mergeParams.commit_title = commitTitle;
      }
      if (commitMessage) {
        mergeParams.commit_message = commitMessage;
      }

      const { data } = await this.octokit.pulls.merge(mergeParams);

      logger.info({ owner, repo, pullNumber, sha: data.sha }, 'Pull request merged');

      return {
        merged: data.merged,
        sha: data.sha,
        message: data.message,
      };
    } catch (error) {
      const wrapped = wrapError(error);

      // Provide more specific error messages for merge issues
      if (wrapped.status === 405) {
        throw new GitHubAPIError(
          405,
          wrapped.technicalMessage,
          'This pull request cannot be merged. It may have conflicts or require approvals.'
        );
      }

      if (wrapped.status === 409) {
        throw new GitHubAPIError(
          409,
          wrapped.technicalMessage,
          'Merge conflict detected. Please resolve conflicts before merging.'
        );
      }

      throw wrapped;
    }
  }

  /**
   * Update a pull request
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param pullNumber - PR number
   * @param updates - Fields to update
   * @returns Updated pull request
   */
  public async updatePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    updates: {
      readonly title?: string;
      readonly body?: string;
      readonly state?: 'open' | 'closed';
      readonly base?: string;
    }
  ): Promise<IGitHubPullRequest> {
    try {
      logger.debug({ owner, repo, pullNumber }, 'Updating pull request');

      // Build update params, only including optional fields if defined
      const updateParams: {
        owner: string;
        repo: string;
        pull_number: number;
        title?: string;
        body?: string;
        state?: 'open' | 'closed';
        base?: string;
      } = {
        owner,
        repo,
        pull_number: pullNumber,
      };

      if (updates.title !== undefined) {
        updateParams.title = updates.title;
      }
      if (updates.body !== undefined) {
        updateParams.body = updates.body;
      }
      if (updates.state !== undefined) {
        updateParams.state = updates.state;
      }
      if (updates.base !== undefined) {
        updateParams.base = updates.base;
      }

      const { data } = await this.octokit.pulls.update(updateParams);

      const pr = this.mapPullRequest(data);

      logger.info({ owner, repo, pullNumber }, 'Pull request updated');

      return pr;
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * Close a pull request without merging
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param pullNumber - PR number
   * @returns Closed pull request
   */
  public async closePullRequest(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<IGitHubPullRequest> {
    return this.updatePullRequest(owner, repo, pullNumber, { state: 'closed' });
  }

  // ==========================================================================
  // Branch Operations
  // ==========================================================================

  /**
   * List branches for a repository
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns List of branch names
   */
  public async listBranches(owner: string, repo: string): Promise<readonly string[]> {
    try {
      const { data } = await this.octokit.repos.listBranches({
        owner,
        repo,
        per_page: 100,
      });

      return data.map((branch) => branch.name);
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * Delete a branch from the remote repository
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param branch - Branch name to delete
   */
  public async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    try {
      logger.info({ owner, repo, branch }, 'Deleting remote branch');

      await this.octokit.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });

      logger.info({ owner, repo, branch }, 'Remote branch deleted');
    } catch (error) {
      throw wrapError(error);
    }
  }

  // ==========================================================================
  // Rate Limit Operations
  // ==========================================================================

  /**
   * Get current rate limit status
   *
   * @returns Rate limit information
   */
  public async getRateLimit(): Promise<IRateLimitInfo> {
    try {
      const { data } = await this.octokit.rateLimit.get();

      const core = data.rate;

      const info: IRateLimitInfo = {
        limit: core.limit,
        remaining: core.remaining,
        reset: new Date(core.reset * 1000),
        used: core.used,
      };

      // Log warning if approaching limit
      if (info.remaining < 100) {
        logger.warn(
          { remaining: info.remaining, reset: info.reset },
          'GitHub API rate limit low'
        );
      }

      return info;
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * Check if rate limit allows more requests
   *
   * @param minimumRemaining - Minimum requests that should remain
   * @returns true if requests are allowed
   */
  public async hasRateLimitCapacity(minimumRemaining: number = 10): Promise<boolean> {
    try {
      const rateLimit = await this.getRateLimit();
      return rateLimit.remaining >= minimumRemaining;
    } catch {
      // If we can't check rate limit, assume we're OK
      return true;
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Map Octokit repository response to our interface
   *
   * Note: Octokit's response types vary by endpoint, so we use a flexible
   * input type and provide sensible defaults for optional fields.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapRepository(data: any): IGitHubRepository {
    // Determine permission level
    let permission: 'admin' | 'push' | 'pull' = 'pull';
    if (data.permissions?.admin) {
      permission = 'admin';
    } else if (data.permissions?.push) {
      permission = 'push';
    }

    const fullName = data.full_name as string;
    const ownerLogin = (data.owner?.login ?? fullName.split('/')[0]) as string;

    return {
      id: data.id as number,
      name: data.name as string,
      fullName,
      owner: ownerLogin,
      description: (data.description ?? null) as string | null,
      url: data.html_url as string,
      cloneUrl: (data.clone_url ?? `https://github.com/${fullName}.git`) as string,
      private: data.private as boolean,
      stars: (data.stargazers_count ?? 0) as number,
      forks: (data.forks_count ?? 0) as number,
      defaultBranch: (data.default_branch ?? 'main') as string,
      permission,
      updatedAt: data.updated_at ? new Date(data.updated_at as string) : new Date(),
    };
  }

  /**
   * Map Octokit pull request response to our interface
   */
  private mapPullRequest(data: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    head: { ref: string };
    base: { ref: string };
    created_at: string;
    updated_at: string;
    merged_at: string | null;
  }): IGitHubPullRequest {
    return {
      id: data.id,
      number: data.number,
      title: data.title,
      body: data.body,
      url: data.html_url,
      state: data.state as 'open' | 'closed' | 'merged',
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
      mergedAt: data.merged_at ? new Date(data.merged_at) : null,
    };
  }
}

/**
 * Factory function to create GitHubAPIService instance
 *
 * @param accessToken - GitHub OAuth access token
 * @returns GitHubAPIService instance
 */
export function createGitHubService(accessToken: string): GitHubAPIService {
  return new GitHubAPIService(accessToken);
}
