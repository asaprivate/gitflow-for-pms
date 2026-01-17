/**
 * Error Translator Service
 *
 * Translates cryptic Git CLI errors and GitHub API errors into
 * human-friendly messages that non-technical PMs can understand.
 *
 * Key Features:
 * - Pattern-based error detection for Git CLI output
 * - HTTP status code handling for Octokit errors
 * - Specific handling for GH009/GH013 push protection violations
 * - Suggested actions for each error type
 * - Severity classification for UI presentation
 *
 * DESIGN PRINCIPLES:
 * - User messages should be understandable by non-technical users
 * - Technical details preserved for debugging/logging
 * - Suggested actions should be actionable without engineering help
 * - Never expose sensitive information in error messages
 */

import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'ErrorTranslator' });

// ============================================================================
// Types
// ============================================================================

/**
 * Severity levels for translated errors
 */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Error category for classification
 */
export type ErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'network'
  | 'git_operation'
  | 'merge_conflict'
  | 'push_protection'
  | 'rate_limit'
  | 'not_found'
  | 'validation'
  | 'unknown';

/**
 * Suggested action for the user
 */
export interface ISuggestedAction {
  /** Action identifier for programmatic handling */
  readonly id: string;
  /** Human-readable label for the action button */
  readonly label: string;
  /** Optional description of what this action does */
  readonly description?: string;
}

/**
 * Translated error with user-friendly messaging
 */
export interface ITranslatedError {
  /** The original error object/message for debugging */
  readonly originalError: unknown;
  /** Simple "what happened" message for the PM */
  readonly userMessage: string;
  /** Technical explanation for debugging/logging */
  readonly technicalDetails: string;
  /** Actionable suggestions (buttons/links) */
  readonly suggestedActions: readonly ISuggestedAction[];
  /** Severity level for UI presentation */
  readonly severity: ErrorSeverity;
  /** Error category for classification */
  readonly category: ErrorCategory;
  /** Error code if available (e.g., 'GH009', 'E401') */
  readonly code?: string;
  /** Affected file(s) if applicable */
  readonly affectedFiles?: readonly string[];
}

/**
 * Pattern definition for error matching
 */
interface IErrorPattern {
  readonly pattern: RegExp;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly userMessage: string | ((match: RegExpMatchArray, error: string) => string);
  readonly suggestedActions: readonly ISuggestedAction[];
  readonly code?: string;
  readonly extractFiles?: (error: string) => string[];
}

/**
 * GitHub API error shape (from Octokit)
 */
interface IOctokitError {
  status?: number;
  response?: {
    status?: number;
    data?: {
      message?: string;
      documentation_url?: string;
      errors?: readonly { message?: string; code?: string }[];
    };
    headers?: Record<string, string>;
  };
  message?: string;
  name?: string;
}

// ============================================================================
// Common Suggested Actions
// ============================================================================

const ACTIONS = {
  RETRY: { id: 'retry', label: 'Retry', description: 'Try the operation again' },
  PULL_LATEST: { id: 'pull_latest', label: 'Pull Latest', description: 'Sync with remote changes' },
  FORCE_PUSH: { id: 'force_push', label: 'Force Push', description: 'Overwrite remote with your changes' },
  LOGIN: { id: 'login', label: 'Sign In', description: 'Authenticate with GitHub' },
  RE_AUTHENTICATE: { id: 're_authenticate', label: 'Re-authenticate', description: 'Refresh your GitHub connection' },
  ASK_ENGINEER: { id: 'ask_engineer', label: 'Ask an Engineer', description: 'Get help from a developer' },
  VIEW_CONFLICTS: { id: 'view_conflicts', label: 'View Conflicts', description: 'See which files have conflicts' },
  RESOLVE_MANUALLY: { id: 'resolve_manually', label: 'Resolve Manually', description: 'Fix conflicts in the editor' },
  DISCARD_CHANGES: { id: 'discard_changes', label: 'Discard Changes', description: 'Remove your local changes' },
  SAVE_CHANGES: { id: 'save_changes', label: 'Save Changes', description: 'Commit your current changes' },
  CHECK_INTERNET: { id: 'check_internet', label: 'Check Internet', description: 'Verify your connection' },
  WAIT_RETRY: { id: 'wait_retry', label: 'Wait and Retry', description: 'Wait a moment and try again' },
  CLONE_AGAIN: { id: 'clone_again', label: 'Clone Again', description: 'Re-clone the repository' },
  REMOVE_SECRET: { id: 'remove_secret', label: 'Remove Secret', description: 'Delete the exposed secret' },
  CHECK_PERMISSIONS: { id: 'check_permissions', label: 'Check Permissions', description: 'Verify repository access' },
  ABORT_MERGE: { id: 'abort_merge', label: 'Abort Merge', description: 'Cancel the merge operation' },
  UPGRADE_PLAN: { id: 'upgrade_plan', label: 'Upgrade Plan', description: 'Get more capacity with Pro' },
} as const;

// ============================================================================
// Git CLI Error Patterns
// ============================================================================

/**
 * Patterns for matching Git CLI error messages
 * Order matters - more specific patterns should come first
 */
const GIT_ERROR_PATTERNS: readonly IErrorPattern[] = [
  // ========== Push Protection / Security Errors ==========
  {
    pattern: /GH009|secret[s]?\s+detected|push.*declined.*secret/i,
    category: 'push_protection',
    severity: 'critical',
    code: 'GH009',
    userMessage: '⚠️ **Security Alert:** GitHub found a secret (like a password or API key) in your code. The push was blocked to protect you.',
    suggestedActions: [ACTIONS.REMOVE_SECRET, ACTIONS.ASK_ENGINEER],
    extractFiles: extractFilesFromError,
  },
  {
    pattern: /GH013|repository\s+rule\s+violations?/i,
    category: 'push_protection',
    severity: 'critical',
    code: 'GH013',
    userMessage: 'GitHub blocked this push due to repository rules. This could be a secret, a large file, or a protected branch.',
    suggestedActions: [ACTIONS.ASK_ENGINEER, ACTIONS.CHECK_PERMISSIONS],
    extractFiles: extractFilesFromError,
  },

  // ========== Authentication Errors ==========
  {
    pattern: /fatal:\s*Authentication\s+failed/i,
    category: 'authentication',
    severity: 'error',
    code: 'AUTH_FAILED',
    userMessage: 'Your GitHub session has expired or is invalid. Please sign in again.',
    suggestedActions: [ACTIONS.RE_AUTHENTICATE, ACTIONS.LOGIN],
  },
  {
    pattern: /Permission\s+denied\s*\(publickey\)/i,
    category: 'authentication',
    severity: 'error',
    code: 'SSH_AUTH_FAILED',
    userMessage: 'GitHub could not verify your identity. Please sign in again.',
    suggestedActions: [ACTIONS.RE_AUTHENTICATE, ACTIONS.ASK_ENGINEER],
  },
  {
    pattern: /401|bad\s+credentials|invalid\s+token/i,
    category: 'authentication',
    severity: 'error',
    code: 'BAD_CREDENTIALS',
    userMessage: 'Your GitHub login has expired. Please sign in again to continue.',
    suggestedActions: [ACTIONS.LOGIN, ACTIONS.RE_AUTHENTICATE],
  },

  // ========== Authorization Errors ==========
  {
    pattern: /403|permission\s+denied|access\s+denied|forbidden/i,
    category: 'authorization',
    severity: 'error',
    code: 'FORBIDDEN',
    userMessage: "You don't have permission to do this. Check that you have the right access to this repository.",
    suggestedActions: [ACTIONS.CHECK_PERMISSIONS, ACTIONS.ASK_ENGINEER],
  },

  // ========== Push Errors ==========
  {
    pattern: /\[rejected\].*non-fast-forward|failed\s+to\s+push\s+some\s+refs|tip\s+of\s+your\s+current\s+branch\s+is\s+behind/i,
    category: 'git_operation',
    severity: 'warning',
    code: 'NON_FAST_FORWARD',
    userMessage: (_match, error) => {
      const behindMatch = error.match(/(\d+)\s+commit[s]?\s+behind/i);
      if (behindMatch) {
        return `Someone else updated this branch. You're ${behindMatch[1]} commit(s) behind. Pull the latest changes first.`;
      }
      return 'Someone else updated this branch while you were working. Pull the latest changes first.';
    },
    suggestedActions: [ACTIONS.PULL_LATEST, ACTIONS.ASK_ENGINEER],
  },
  {
    pattern: /remote.*rejected|push\s+failed/i,
    category: 'git_operation',
    severity: 'error',
    code: 'PUSH_REJECTED',
    userMessage: "Couldn't publish your changes. The remote server rejected the push.",
    suggestedActions: [ACTIONS.PULL_LATEST, ACTIONS.RETRY, ACTIONS.ASK_ENGINEER],
  },

  // ========== Merge Conflict Errors ==========
  {
    pattern: /CONFLICT\s*\(content\s*\):\s*Merge\s+conflict\s+in\s+(.+)|Automatic\s+merge\s+failed/i,
    category: 'merge_conflict',
    severity: 'error',
    code: 'MERGE_CONFLICT',
    userMessage: (_match, error) => {
      const files = extractConflictFiles(error);
      if (files.length > 0) {
        const fileList = files.slice(0, 3).join(', ');
        const more = files.length > 3 ? ` and ${files.length - 3} more` : '';
        return `Merge conflict! Both you and someone else changed the same files: ${fileList}${more}. These need to be resolved.`;
      }
      return 'Merge conflict! The same parts of files were changed by you and someone else. These need to be resolved.';
    },
    suggestedActions: [ACTIONS.VIEW_CONFLICTS, ACTIONS.RESOLVE_MANUALLY, ACTIONS.ASK_ENGINEER, ACTIONS.ABORT_MERGE],
    extractFiles: extractConflictFiles,
  },
  {
    pattern: /Your\s+local\s+changes.*would\s+be\s+overwritten/i,
    category: 'merge_conflict',
    severity: 'warning',
    code: 'LOCAL_CHANGES_CONFLICT',
    userMessage: "You have unsaved changes that would be lost. Save or discard them before continuing.",
    suggestedActions: [ACTIONS.SAVE_CHANGES, ACTIONS.DISCARD_CHANGES],
  },

  // ========== Repository State Errors ==========
  {
    pattern: /fatal:\s*not\s+a\s+git\s+repository/i,
    category: 'git_operation',
    severity: 'error',
    code: 'NOT_A_REPO',
    userMessage: "Something's wrong with this project. The Git setup seems to be broken.",
    suggestedActions: [ACTIONS.CLONE_AGAIN, ACTIONS.ASK_ENGINEER],
  },
  {
    pattern: /fatal:\s*['"]?origin['"]?\s+does\s+not\s+appear\s+to\s+be\s+a\s+git\s+repository/i,
    category: 'network',
    severity: 'error',
    code: 'REMOTE_NOT_FOUND',
    userMessage: 'Lost connection to GitHub. The repository link might be broken.',
    suggestedActions: [ACTIONS.CHECK_INTERNET, ACTIONS.CLONE_AGAIN, ACTIONS.ASK_ENGINEER],
  },
  {
    pattern: /error:\s*pathspec\s+'([^']+)'\s+did\s+not\s+match/i,
    category: 'git_operation',
    severity: 'error',
    code: 'PATHSPEC_NOT_FOUND',
    userMessage: (regexMatch) => {
      const target = regexMatch[1] ?? 'the branch';
      return `"${target}" doesn't exist. It might have been deleted or renamed.`;
    },
    suggestedActions: [ACTIONS.PULL_LATEST, ACTIONS.ASK_ENGINEER],
  },
  {
    pattern: /error:\s*cannot\s+lock\s+ref\s+'refs\/heads\/([^']+)'/i,
    category: 'git_operation',
    severity: 'error',
    code: 'BRANCH_LOCK_FAILED',
    userMessage: (regexMatch) => {
      const branch = regexMatch[1] ?? 'this branch';
      return `Can't create branch "${branch}". Try using a different name.`;
    },
    suggestedActions: [ACTIONS.RETRY, ACTIONS.ASK_ENGINEER],
  },

  // ========== Network Errors ==========
  // NOTE: More specific patterns (timeout) should come BEFORE general patterns (network error)
  {
    pattern: /Connection\s+timed?\s*out|timed?\s*out\s+after/i,
    category: 'network',
    severity: 'warning',
    code: 'TIMEOUT',
    userMessage: 'The connection timed out. GitHub might be slow or your internet might be unstable.',
    suggestedActions: [ACTIONS.RETRY, ACTIONS.CHECK_INTERNET],
  },
  {
    pattern: /Could\s+not\s+resolve\s+host|unable\s+to\s+access|network\s+is\s+unreachable/i,
    category: 'network',
    severity: 'error',
    code: 'NETWORK_ERROR',
    userMessage: "Can't connect to GitHub. Please check your internet connection.",
    suggestedActions: [ACTIONS.CHECK_INTERNET, ACTIONS.RETRY],
  },
  {
    pattern: /SSL\s+certificate\s+problem|certificate\s+verify\s+failed/i,
    category: 'network',
    severity: 'error',
    code: 'SSL_ERROR',
    userMessage: 'Secure connection failed. There might be a network issue.',
    suggestedActions: [ACTIONS.CHECK_INTERNET, ACTIONS.ASK_ENGINEER],
  },

  // ========== Empty/Clean State Errors ==========
  {
    pattern: /nothing\s+to\s+commit|working\s+(tree|directory)\s+clean/i,
    category: 'git_operation',
    severity: 'info',
    code: 'NOTHING_TO_COMMIT',
    userMessage: "There are no changes to save. Everything is up to date!",
    suggestedActions: [],
  },
  {
    pattern: /Already\s+up\s+to\s+date/i,
    category: 'git_operation',
    severity: 'info',
    code: 'UP_TO_DATE',
    userMessage: "You're already up to date with the latest changes.",
    suggestedActions: [],
  },

  // ========== Branch Errors ==========
  {
    // Matches: "A branch named 'x' already exists" or "branch 'x' already exists"
    pattern: /branch\s+(?:named\s+)?'([^']+)'\s+already\s+exists/i,
    category: 'git_operation',
    severity: 'warning',
    code: 'BRANCH_EXISTS',
    userMessage: (regexMatch) => {
      const branch = regexMatch[1] ?? 'this branch';
      return `Branch "${branch}" already exists. Try a different name.`;
    },
    suggestedActions: [ACTIONS.RETRY],
  },
  {
    pattern: /branch\s+'([^']+)'\s+is\s+not\s+fully\s+merged/i,
    category: 'git_operation',
    severity: 'warning',
    code: 'BRANCH_NOT_MERGED',
    userMessage: (match) => {
      const branch = match[1] ?? 'This branch';
      return `"${branch}" has changes that haven't been merged yet. Are you sure you want to delete it?`;
    },
    suggestedActions: [ACTIONS.FORCE_PUSH, ACTIONS.ASK_ENGINEER],
  },
];

// ============================================================================
// GitHub API Error Mappings
// ============================================================================

/**
 * HTTP status code to error translation
 */
const HTTP_STATUS_MAPPINGS: Record<number, {
  category: ErrorCategory;
  severity: ErrorSeverity;
  userMessage: string;
  suggestedActions: readonly ISuggestedAction[];
}> = {
  400: {
    category: 'validation',
    severity: 'error',
    userMessage: 'The request was invalid. Please check your input and try again.',
    suggestedActions: [ACTIONS.RETRY, ACTIONS.ASK_ENGINEER],
  },
  401: {
    category: 'authentication',
    severity: 'error',
    userMessage: 'Your GitHub session has expired. Please sign in again.',
    suggestedActions: [ACTIONS.LOGIN, ACTIONS.RE_AUTHENTICATE],
  },
  403: {
    category: 'authorization',
    severity: 'error',
    userMessage: "You don't have permission to perform this action. Check your repository access.",
    suggestedActions: [ACTIONS.CHECK_PERMISSIONS, ACTIONS.ASK_ENGINEER],
  },
  404: {
    category: 'not_found',
    severity: 'error',
    userMessage: "Couldn't find that resource. It might have been deleted or you may not have access.",
    suggestedActions: [ACTIONS.CHECK_PERMISSIONS, ACTIONS.RETRY],
  },
  409: {
    category: 'merge_conflict',
    severity: 'error',
    userMessage: 'There was a conflict with the current state. Someone else may have made changes.',
    suggestedActions: [ACTIONS.PULL_LATEST, ACTIONS.RETRY],
  },
  422: {
    category: 'validation',
    severity: 'error',
    userMessage: 'The request could not be processed. The data might be invalid.',
    suggestedActions: [ACTIONS.RETRY, ACTIONS.ASK_ENGINEER],
  },
  429: {
    category: 'rate_limit',
    severity: 'warning',
    userMessage: 'Too many requests! GitHub needs a short break. Wait a moment and try again.',
    suggestedActions: [ACTIONS.WAIT_RETRY],
  },
  500: {
    category: 'unknown',
    severity: 'error',
    userMessage: 'GitHub is having issues. Please try again in a few minutes.',
    suggestedActions: [ACTIONS.RETRY, ACTIONS.WAIT_RETRY],
  },
  502: {
    category: 'network',
    severity: 'error',
    userMessage: 'GitHub servers are temporarily unavailable. Please try again shortly.',
    suggestedActions: [ACTIONS.WAIT_RETRY, ACTIONS.RETRY],
  },
  503: {
    category: 'network',
    severity: 'error',
    userMessage: 'GitHub is temporarily unavailable for maintenance. Please try again later.',
    suggestedActions: [ACTIONS.WAIT_RETRY],
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract file paths from an error message
 */
function extractFilesFromError(error: string): string[] {
  const files: string[] = [];
  const patterns = [
    /([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+):(\d+)/g,
    /in\s+file\s+([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/gi,
    /detected\s+in\s+([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/gi,
  ];

  const seen = new Set<string>();

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(error)) !== null) {
      const file = match[1];
      if (file && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }

  return files;
}

/**
 * Extract files involved in merge conflicts
 */
function extractConflictFiles(error: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  // Pattern: "Merge conflict in filename"
  const conflictPattern = /Merge\s+conflict\s+in\s+([^\s\n]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = conflictPattern.exec(error)) !== null) {
    const file = match[1];
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }

  // Pattern: "CONFLICT (content): Merge conflict in filename"
  const conflictContentPattern = /CONFLICT\s*\([^)]+\):\s*Merge\s+conflict\s+in\s+([^\s\n]+)/gi;

  while ((match = conflictContentPattern.exec(error)) !== null) {
    const file = match[1];
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }

  return files;
}

/**
 * Check if an error object is an Octokit error
 */
function isOctokitError(error: unknown): error is IOctokitError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const err = error as Record<string, unknown>;

  return (
    'status' in err ||
    'response' in err ||
    (err['name'] === 'HttpError' || err['name'] === 'RequestError')
  );
}

/**
 * Get the error message from various error types
 */
function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (isOctokitError(error)) {
    return (
      error.response?.data?.message ??
      error.message ??
      'Unknown GitHub API error'
    );
  }

  return String(error);
}

/**
 * Get HTTP status from an error
 */
function getHttpStatus(error: unknown): number | undefined {
  if (isOctokitError(error)) {
    return error.status ?? error.response?.status;
  }
  return undefined;
}

// ============================================================================
// Error Translator Class
// ============================================================================

/**
 * Error Translator
 *
 * Translates technical Git and GitHub errors into user-friendly messages.
 * All methods are static for ease of use.
 */
export class ErrorTranslator {
  /**
   * Translate any error into a user-friendly format
   *
   * @param error - The original error (string, Error, or Octokit error)
   * @returns Translated error with user message and suggestions
   */
  public static translate(error: unknown): ITranslatedError {
    const errorMessage = getErrorMessage(error);
    const httpStatus = getHttpStatus(error);

    logger.debug(
      { errorMessage, httpStatus, errorType: typeof error },
      'Translating error'
    );

    // First, try HTTP status-based translation for API errors
    if (httpStatus && httpStatus in HTTP_STATUS_MAPPINGS) {
      return ErrorTranslator.translateHttpError(error, httpStatus, errorMessage);
    }

    // Then, try pattern-based translation for Git errors
    return ErrorTranslator.translateGitError(error, errorMessage);
  }

  /**
   * Translate a Git CLI error
   */
  private static translateGitError(
    originalError: unknown,
    errorMessage: string
  ): ITranslatedError {
    // Try each pattern in order
    for (const pattern of GIT_ERROR_PATTERNS) {
      const match = errorMessage.match(pattern.pattern);
      if (match) {
        // Compute user message (may be a function)
        const userMessage =
          typeof pattern.userMessage === 'function'
            ? pattern.userMessage(match, errorMessage)
            : pattern.userMessage;

        // Extract affected files if pattern supports it
        const affectedFiles = pattern.extractFiles?.(errorMessage);

        // Build result object - only include optional properties when defined
        // to satisfy exactOptionalPropertyTypes
        const result: ITranslatedError = {
          originalError,
          userMessage,
          technicalDetails: errorMessage,
          suggestedActions: pattern.suggestedActions,
          severity: pattern.severity,
          category: pattern.category,
          ...(pattern.code !== undefined && { code: pattern.code }),
          ...(affectedFiles && affectedFiles.length > 0 && { affectedFiles }),
        };

        logger.info(
          { code: pattern.code, category: pattern.category, fileCount: affectedFiles?.length ?? 0 },
          'Translated Git error'
        );

        return result;
      }
    }

    // No pattern matched - return generic error
    return ErrorTranslator.createGenericError(originalError, errorMessage);
  }

  /**
   * Translate an HTTP/API error
   */
  private static translateHttpError(
    originalError: unknown,
    status: number,
    errorMessage: string
  ): ITranslatedError {
    const mapping = HTTP_STATUS_MAPPINGS[status];

    if (!mapping) {
      return ErrorTranslator.createGenericError(originalError, errorMessage);
    }

    // Check for specific GitHub API error messages
    let userMessage = mapping.userMessage;
    let category = mapping.category;
    const suggestedActions = [...mapping.suggestedActions];

    // Enhance message based on error content
    if (isOctokitError(originalError)) {
      const apiMessage = originalError.response?.data?.message?.toLowerCase() ?? '';

      // Rate limit specific handling
      if (status === 403 && apiMessage.includes('rate limit')) {
        category = 'rate_limit';
        userMessage = 'You\'ve made too many requests. Please wait a few minutes and try again.';
        suggestedActions.length = 0;
        suggestedActions.push(ACTIONS.WAIT_RETRY);
      }

      // Secondary rate limit
      if (status === 403 && apiMessage.includes('secondary rate limit')) {
        category = 'rate_limit';
        userMessage = 'GitHub detected unusual activity. Please wait a minute and try again.';
      }

      // Push protection via API
      if (apiMessage.includes('secret') || apiMessage.includes('push protection')) {
        category = 'push_protection';
        userMessage = '⚠️ **Security Alert:** GitHub blocked this action because it detected a secret in your code.';
        suggestedActions.length = 0;
        suggestedActions.push(ACTIONS.REMOVE_SECRET, ACTIONS.ASK_ENGINEER);
      }
    }

    logger.info(
      { status, category },
      'Translated HTTP error'
    );

    return {
      originalError,
      userMessage,
      technicalDetails: `HTTP ${status}: ${errorMessage}`,
      suggestedActions,
      severity: mapping.severity,
      category,
      code: `HTTP_${status}`,
    };
  }

  /**
   * Create a generic error when no specific pattern matches
   */
  private static createGenericError(
    originalError: unknown,
    errorMessage: string
  ): ITranslatedError {
    logger.warn(
      { errorMessage: errorMessage.substring(0, 200) },
      'No specific pattern matched - returning generic error'
    );

    return {
      originalError,
      userMessage: 'Something went wrong. Please try again or ask for help if the problem continues.',
      technicalDetails: errorMessage,
      suggestedActions: [ACTIONS.RETRY, ACTIONS.ASK_ENGINEER],
      severity: 'error',
      category: 'unknown',
    };
  }

  /**
   * Translate a merge conflict specifically
   *
   * @param conflictFiles - List of files with conflicts
   * @returns Translated error for merge conflict
   */
  public static translateMergeConflict(conflictFiles: readonly string[]): ITranslatedError {
    const fileList = conflictFiles.slice(0, 5).join(', ');
    const more = conflictFiles.length > 5 ? ` and ${conflictFiles.length - 5} more` : '';

    return {
      originalError: null,
      userMessage: `Merge conflict detected in: ${fileList}${more}. Both you and someone else changed the same parts of these files.`,
      technicalDetails: `Conflict in ${conflictFiles.length} file(s): ${conflictFiles.join(', ')}`,
      suggestedActions: [ACTIONS.VIEW_CONFLICTS, ACTIONS.RESOLVE_MANUALLY, ACTIONS.ASK_ENGINEER],
      severity: 'error',
      category: 'merge_conflict',
      code: 'MERGE_CONFLICT',
      affectedFiles: conflictFiles,
    };
  }

  /**
   * Translate a push protection violation
   *
   * @param files - Files containing secrets
   * @param secretType - Type of secret detected (if known)
   * @returns Translated error for push protection
   */
  public static translatePushProtection(
    files: readonly string[],
    secretType?: string
  ): ITranslatedError {
    const fileList = files.length > 0 ? files.join(', ') : 'your code';
    const secretInfo = secretType ? ` (${secretType})` : '';

    // Build base result
    const result: ITranslatedError = {
      originalError: null,
      userMessage: `⚠️ **Security Alert:** GitHub detected a secret${secretInfo} in ${fileList}. The push was blocked to keep your code safe.`,
      technicalDetails: `Push protection triggered: Secret found in ${files.length > 0 ? files.join(', ') : 'committed files'}`,
      suggestedActions: [ACTIONS.REMOVE_SECRET, ACTIONS.ASK_ENGINEER],
      severity: 'critical',
      category: 'push_protection',
      code: 'GH009',
      // Only include affectedFiles if there are files (exactOptionalPropertyTypes)
      ...(files.length > 0 && { affectedFiles: files }),
    };

    return result;
  }

  /**
   * Check if an error is a specific category
   */
  public static isCategory(error: ITranslatedError, category: ErrorCategory): boolean {
    return error.category === category;
  }

  /**
   * Check if an error is recoverable (can be fixed without engineering help)
   */
  public static isRecoverable(error: ITranslatedError): boolean {
    const recoverableCategories: ErrorCategory[] = [
      'authentication',
      'network',
      'rate_limit',
      'merge_conflict',
    ];

    return recoverableCategories.includes(error.category);
  }

  /**
   * Get the primary suggested action (first in list)
   */
  public static getPrimaryAction(error: ITranslatedError): ISuggestedAction | null {
    return error.suggestedActions[0] ?? null;
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Quick translate function for inline use
 */
export function translateError(error: unknown): ITranslatedError {
  return ErrorTranslator.translate(error);
}

/**
 * Get just the user message from an error
 */
export function getUserMessage(error: unknown): string {
  return ErrorTranslator.translate(error).userMessage;
}

/**
 * Check if an error is a push protection violation
 */
export function isPushProtectionError(error: unknown): boolean {
  const translated = ErrorTranslator.translate(error);
  return translated.category === 'push_protection';
}

/**
 * Check if an error requires re-authentication
 */
export function requiresReAuthentication(error: unknown): boolean {
  const translated = ErrorTranslator.translate(error);
  return translated.category === 'authentication';
}
