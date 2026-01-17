/**
 * Services Layer
 *
 * This module exports all business logic services for the GitFlow MCP Server.
 * Services contain the core application logic and orchestrate between
 * repositories (data access) and MCP tools (API surface).
 *
 * Implemented Services:
 * - AuthService: GitHub OAuth authentication and token management
 * - GitService: Local Git operations (clone, commit, push, pull, merge)
 * - PolicyRejectionHandler: Handle GH009/GH013 push protection violations
 * - GitHubAPIService: GitHub API interactions (repos, PRs, users)
 * - ErrorTranslator: Convert Git/GitHub errors to human-friendly messages (NEW)
 *
 * Pending Services:
 * - LicenseService: Rate limiting and subscription tier management
 * - FileWatcherService: Monitor local file changes with debouncing
 * - SessionService: Task and PR state tracking
 */

// Services exported as they are implemented
export { AuthService, authService } from './AuthService.js';
export type { IOAuthInitResponse, IOAuthCallbackResponse } from './AuthService.js';

export { GitService, createGitService, generateLocalPath } from './GitService.js';
export type {
  ICloneOptions,
  ICommitOptions,
  IPushOptions,
  IPullOptions,
  IMergeOptions,
  ResetMode,
  IPushRejectionHandled,
  PushOperationResult,
  IBranchInfo,
  IRepoConfig,
} from './GitService.js';

export {
  PolicyRejectionHandler,
  policyRejectionHandler,
  PolicyViolationType,
} from './PolicyRejectionHandler.js';
export type {
  SecretType,
  ISecretViolation,
  IPolicyViolationResult,
  ISanitizeResult,
  IVerifySecretResult,
  IRetryPushResult,
} from './PolicyRejectionHandler.js';

export { GitHubAPIService, GitHubAPIError, createGitHubService } from './GitHubAPIService.js';
export type {
  IRateLimitInfo,
  IListReposOptions,
  ICreatePullRequestOptions,
  IMergePullRequestOptions,
  IPullRequestStatus,
  IOrganization,
} from './GitHubAPIService.js';

export {
  ErrorTranslator,
  translateError,
  getUserMessage,
  isPushProtectionError,
  requiresReAuthentication,
} from './ErrorTranslator.js';
export type {
  ErrorSeverity,
  ErrorCategory,
  ISuggestedAction,
  ITranslatedError,
} from './ErrorTranslator.js';

// export { LicenseService } from './LicenseService.js';
// export { FileWatcherService } from './FileWatcherService.js';
// export { SessionService } from './SessionService.js';

import type { AuthService } from './AuthService.js';
import type { GitService } from './GitService.js';
import type { PolicyRejectionHandler } from './PolicyRejectionHandler.js';
import type { GitHubAPIService } from './GitHubAPIService.js';
import type { ErrorTranslator } from './ErrorTranslator.js';

/**
 * Service container interface for dependency injection
 */
export interface IServiceContainer {
  authService: AuthService;
  gitService?: GitService;
  policyRejectionHandler: PolicyRejectionHandler;
  gitHubAPIService?: GitHubAPIService;
  errorTranslator: typeof ErrorTranslator;
  // LicenseService: LicenseService;
  // FileWatcherService: FileWatcherService;
  // SessionService: SessionService;
}

import { authService as authServiceInstance } from './AuthService.js';
import { policyRejectionHandler as policyRejectionHandlerInstance } from './PolicyRejectionHandler.js';
import { ErrorTranslator as ErrorTranslatorClass } from './ErrorTranslator.js';

/**
 * Create service container with initialized services
 *
 * Note: GitService and GitHubAPIService are not included here as they require
 * a userId/localPath or accessToken to be instantiated.
 * Use createGitService() or createGitHubService() to create instances as needed.
 *
 * ErrorTranslator is a static class, so we include the class itself rather than an instance.
 */
export function createServiceContainer(): IServiceContainer {
  return {
    authService: authServiceInstance,
    policyRejectionHandler: policyRejectionHandlerInstance,
    errorTranslator: ErrorTranslatorClass,
    // Additional services will be added here
  };
}
