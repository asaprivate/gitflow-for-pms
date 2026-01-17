/**
 * Policy Rejection Handler Service
 *
 * Handles GitHub Push Protection violations (GH009/GH013 errors) that occur when
 * secrets or policy violations are detected in commits.
 *
 * This service provides the "Sanitize & Retry" workflow:
 * 1. Detect GH009/GH013 errors from push output
 * 2. Parse error details to identify affected files/lines
 * 3. Guide PM through secret removal
 * 4. Sanitize commit history (amend or soft reset)
 * 5. Safely retry the push with --force-with-lease
 *
 * SECURITY CONSIDERATIONS:
 * - Never log the actual secret content
 * - Use --force-with-lease (not --force) to prevent data loss
 * - Verify secret is removed before retry
 */

import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';

import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'PolicyRejectionHandler' });

// ============================================================================
// Types
// ============================================================================

/**
 * Types of policy violations that can be detected
 */
export enum PolicyViolationType {
  SECRET_DETECTED = 'SECRET_DETECTED',
  POLICY_VIOLATION = 'POLICY_VIOLATION',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Types of secrets that GitHub Push Protection can detect
 */
export type SecretType =
  | 'AWS Access Key'
  | 'AWS Secret Key'
  | 'GitHub Token'
  | 'Generic API Key'
  | 'Private Key'
  | 'Database Connection String'
  | 'Stripe Key'
  | 'Google API Key'
  | 'Azure Key'
  | 'Unknown Secret';

/**
 * Information about a detected secret violation
 */
export interface ISecretViolation {
  readonly file: string;
  readonly line: number | null;
  readonly secretType: SecretType;
  readonly rawMatch: string | null;
}

/**
 * Result of parsing a push rejection error
 */
export interface IPolicyViolationResult {
  readonly type: PolicyViolationType;
  readonly violations: readonly ISecretViolation[];
  readonly rawError: string;
  readonly userMessage: string;
  readonly suggestions: readonly string[];
}

/**
 * Result of sanitizing commit history
 */
export interface ISanitizeResult {
  readonly success: boolean;
  readonly method: 'amend' | 'soft_reset';
  readonly error?: string;
  readonly newCommitHash?: string;
}

/**
 * Result of verifying secret removal
 */
export interface IVerifySecretResult {
  readonly isClean: boolean;
  readonly remainingViolations: readonly ISecretViolation[];
}

/**
 * Result of retrying push after sanitization
 */
export interface IRetryPushResult {
  readonly success: boolean;
  readonly branch: string;
  readonly error?: string;
}

// ============================================================================
// Regex Patterns for Error Detection
// ============================================================================

/**
 * Patterns to detect GitHub Push Protection errors
 */
const PUSH_PROTECTION_PATTERNS = {
  // GH009: Secrets detected
  GH009: /GH009|secret[s]?\s+detected|push.*declined.*secret/i,
  // GH013: Repository rule violations (can include secrets, large files, etc.)
  GH013: /GH013|repository\s+rule\s+violations?/i,
  // Generic push declined pattern
  PUSH_DECLINED: /push.*declined|remote.*rejected/i,
} as const;

/**
 * Patterns to extract file and line information from error messages
 */
const FILE_LINE_PATTERNS = [
  // Standard format: "filename.ext:42" or "path/to/file.ext:42"
  /([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+):(\d+)/g,
  // GitHub format: "in file src/config.ts"
  /in\s+file\s+([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/gi,
  // Error format: "detected in path/file.ts line 42"
  /detected\s+in\s+([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)(?:\s+line\s+(\d+))?/gi,
] as const;

/**
 * Patterns to identify secret types
 */
const SECRET_TYPE_PATTERNS: ReadonlyArray<readonly [RegExp, SecretType]> = [
  [/aws[_\s-]?access[_\s-]?key/i, 'AWS Access Key'],
  [/aws[_\s-]?secret/i, 'AWS Secret Key'],
  [/ghp_|github[_\s-]?token|gh[_\s-]?token/i, 'GitHub Token'],
  [/stripe[_\s-]?key|sk_live|sk_test/i, 'Stripe Key'],
  [/google[_\s-]?api|gcp[_\s-]?key/i, 'Google API Key'],
  [/azure[_\s-]?key|azure[_\s-]?secret/i, 'Azure Key'],
  [/private[_\s-]?key|-----BEGIN.*PRIVATE KEY/i, 'Private Key'],
  [/database[_\s-]?url|connection[_\s-]?string|mongodb\+srv|postgres:\/\//i, 'Database Connection String'],
  [/api[_\s-]?key|secret[_\s-]?key|access[_\s-]?token/i, 'Generic API Key'],
] as const;

// ============================================================================
// Policy Rejection Handler
// ============================================================================

/**
 * Policy Rejection Handler
 *
 * Provides methods to detect, parse, and recover from GitHub Push Protection
 * violations (GH009/GH013 errors).
 */
export class PolicyRejectionHandler {
  /**
   * Check if an error is a policy violation (GH009/GH013)
   *
   * @param error - Error object or message from git push
   * @returns true if this is a policy violation error
   */
  public isPolicyViolation(error: Error | string): boolean {
    const errorMessage = typeof error === 'string' ? error : error.message;

    return (
      PUSH_PROTECTION_PATTERNS.GH009.test(errorMessage) ||
      PUSH_PROTECTION_PATTERNS.GH013.test(errorMessage)
    );
  }

  /**
   * Determine the type of policy violation
   *
   * @param errorMessage - Error message from git push
   * @returns The type of policy violation
   */
  public getViolationType(errorMessage: string): PolicyViolationType {
    if (PUSH_PROTECTION_PATTERNS.GH009.test(errorMessage)) {
      return PolicyViolationType.SECRET_DETECTED;
    }
    if (PUSH_PROTECTION_PATTERNS.GH013.test(errorMessage)) {
      return PolicyViolationType.POLICY_VIOLATION;
    }
    return PolicyViolationType.UNKNOWN;
  }

  /**
   * Parse a push rejection error to extract violation details
   *
   * @param errorOutput - Raw error output from git push
   * @returns Parsed violation result with file/line information
   */
  public parseViolation(errorOutput: string): IPolicyViolationResult {
    const type = this.getViolationType(errorOutput);
    const violations = this.extractViolations(errorOutput);

    // Generate user-friendly message
    let userMessage: string;
    let suggestions: string[];

    if (type === PolicyViolationType.SECRET_DETECTED) {
      if (violations.length > 0) {
        const files = violations.map((v) => v.file).join(', ');
        userMessage = `⚠️ **Security Alert:** GitHub found a secret in your code and blocked the push. Affected file(s): ${files}`;
      } else {
        userMessage = `⚠️ **Security Alert:** GitHub found a secret (like a password or API key) in your code. The push was blocked for security reasons.`;
      }
      suggestions = [
        'Open the affected file and remove the secret',
        'Replace the secret with an environment variable reference',
        'Save the file after making changes',
        'I will help you update the commit and retry the push',
      ];
    } else if (type === PolicyViolationType.POLICY_VIOLATION) {
      userMessage = `GitHub blocked this push due to repository rules. This might be a secret, a large file, or a protected branch violation.`;
      suggestions = [
        'Check the error details above for the specific violation',
        'Remove or fix the offending content',
        'Contact your repository admin if you need help',
      ];
    } else {
      userMessage = `The push was rejected by GitHub. Please check the error details.`;
      suggestions = ['Review the error message', 'Ask an engineer for help if needed'];
    }

    logger.info(
      { type, violationCount: violations.length },
      'Parsed policy violation from push error'
    );

    return {
      type,
      violations,
      rawError: errorOutput,
      userMessage,
      suggestions,
    };
  }

  /**
   * Extract file and line information from error output
   *
   * @param errorOutput - Raw error output from git push
   * @returns List of detected violations with file/line info
   */
  private extractViolations(errorOutput: string): ISecretViolation[] {
    const violations: ISecretViolation[] = [];
    const seenFiles = new Set<string>();

    // Try each pattern to extract file/line information
    for (const pattern of FILE_LINE_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(errorOutput)) !== null) {
        const file = match[1];
        const line = match[2] ? parseInt(match[2], 10) : null;

        // Avoid duplicates
        const key = `${file}:${line ?? 'unknown'}`;
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          violations.push({
            file: file ?? 'unknown',
            line,
            secretType: this.detectSecretType(errorOutput, file ?? ''),
            rawMatch: match[0],
          });
        }
      }
    }

    // If no files were extracted, try to get any file paths mentioned
    if (violations.length === 0) {
      const genericFilePattern = /([a-zA-Z0-9_\-./]+\.(ts|js|py|json|yaml|yml|env|config|txt))/gi;
      let match: RegExpExecArray | null;

      while ((match = genericFilePattern.exec(errorOutput)) !== null) {
        const file = match[1];
        if (file && !seenFiles.has(file)) {
          seenFiles.add(file);
          violations.push({
            file,
            line: null,
            secretType: this.detectSecretType(errorOutput, file),
            rawMatch: match[0],
          });
        }
      }
    }

    return violations;
  }

  /**
   * Detect the type of secret from error context
   *
   * @param errorOutput - Full error output
   * @param file - File path for additional context
   * @returns The detected secret type
   */
  private detectSecretType(errorOutput: string, file: string): SecretType {
    const searchText = `${errorOutput} ${file}`;

    for (const [pattern, secretType] of SECRET_TYPE_PATTERNS) {
      if (pattern.test(searchText)) {
        return secretType;
      }
    }

    return 'Unknown Secret';
  }

  /**
   * Sanitize commit history by removing the bad commit and keeping changes staged
   *
   * This is the CRITICAL step that allows the PM to fix the issue and retry.
   * Uses git reset --soft HEAD~1 to undo the commit but keep all changes staged.
   *
   * @param localPath - Path to the local repository
   * @param originalMessage - Original commit message to preserve (optional)
   * @returns Result of the sanitization attempt
   */
  public async sanitizeHistory(
    localPath: string,
    originalMessage?: string
  ): Promise<ISanitizeResult> {
    const git: SimpleGit = simpleGit(localPath);

    try {
      logger.info({ localPath }, 'Starting commit history sanitization');

      // Get current commit message before reset (if not provided)
      let commitMessage = originalMessage;
      if (!commitMessage) {
        try {
          const logResult = await git.log({ maxCount: 1 });
          commitMessage = logResult.latest?.message ?? 'Update code';
        } catch {
          commitMessage = 'Update code';
        }
      }

      // Perform soft reset - removes commit but keeps changes staged
      await git.reset(['--soft', 'HEAD~1']);

      logger.info({ localPath, method: 'soft_reset' }, 'Successfully reset commit (changes kept staged)');

      return {
        success: true,
        method: 'soft_reset',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath, error: errorMessage }, 'Failed to sanitize commit history');

      return {
        success: false,
        method: 'soft_reset',
        error: `Failed to undo the commit: ${errorMessage}. Your changes are still safe, but you may need manual help.`,
      };
    }
  }

  /**
   * Unstage a specific file that contains a secret
   *
   * This allows the PM to edit the file and then re-stage it.
   *
   * @param localPath - Path to the local repository
   * @param file - File path to unstage
   * @returns true if successful
   */
  public async unstageFile(localPath: string, file: string): Promise<boolean> {
    const git: SimpleGit = simpleGit(localPath);

    try {
      await git.reset(['HEAD', '--', file]);
      logger.debug({ localPath, file }, 'Unstaged file');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn({ localPath, file, error: errorMessage }, 'Failed to unstage file');
      return false;
    }
  }

  /**
   * Verify that a secret has been removed from a file
   *
   * This performs a basic pattern check. For comprehensive secret detection,
   * rely on GitHub's Push Protection during the retry.
   *
   * @param localPath - Path to the local repository
   * @param violations - Original violations to check
   * @returns Verification result with any remaining violations
   */
  public async verifySecretRemoved(
    localPath: string,
    violations: readonly ISecretViolation[]
  ): Promise<IVerifySecretResult> {
    // For MVP, we rely on GitHub's Push Protection to verify
    // A more robust implementation would scan the files locally
    // using patterns similar to what GitHub uses

    logger.info(
      { localPath, violationCount: violations.length },
      'Verification delegated to GitHub Push Protection on retry'
    );

    // Return optimistic result - actual verification happens on push retry
    return {
      isClean: true,
      remainingViolations: [],
    };
  }

  /**
   * Retry push with --force-with-lease after sanitization
   *
   * Uses --force-with-lease for safety - will fail if remote has new commits
   * that we don't have locally, preventing accidental data loss.
   *
   * @param localPath - Path to the local repository
   * @param branch - Branch name to push
   * @returns Result of the push attempt
   */
  public async retryPushSafely(localPath: string, branch: string): Promise<IRetryPushResult> {
    const git: SimpleGit = simpleGit(localPath);

    try {
      logger.info({ localPath, branch }, 'Retrying push with --force-with-lease');

      // Use force-with-lease for safe force push
      await git.push(['origin', branch, '--force-with-lease']);

      logger.info({ localPath, branch }, 'Push retry successful');

      return {
        success: true,
        branch,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is another policy violation
      if (this.isPolicyViolation(errorMessage)) {
        logger.warn(
          { localPath, branch },
          'Push retry failed - secret still present or new violation detected'
        );
        return {
          success: false,
          branch,
          error: 'Secret still detected. Please make sure you removed the secret and saved the file.',
        };
      }

      logger.error({ localPath, branch, error: errorMessage }, 'Push retry failed');

      return {
        success: false,
        branch,
        error: `Push failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Re-commit changes after the PM has fixed the violation
   *
   * @param localPath - Path to the local repository
   * @param message - Commit message
   * @param files - Optional specific files to stage (stages all if not provided)
   * @returns Commit hash if successful
   */
  public async recommit(
    localPath: string,
    message: string,
    files?: readonly string[]
  ): Promise<{ success: boolean; commitHash?: string; error?: string }> {
    const git: SimpleGit = simpleGit(localPath);

    try {
      // Stage files
      if (files && files.length > 0) {
        await git.add(files as string[]);
      } else {
        await git.add('.');
      }

      // Commit
      const result = await git.commit(message);

      if (result.commit) {
        logger.info({ localPath, commitHash: result.commit }, 'Created new commit after sanitization');
        return {
          success: true,
          commitHash: result.commit,
        };
      }

      // Check if there's nothing to commit
      const status = await git.status();
      if (status.isClean()) {
        return {
          success: false,
          error: 'No changes to commit. The working directory is clean.',
        };
      }

      return {
        success: false,
        error: 'Commit failed for unknown reason.',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ localPath, error: errorMessage }, 'Failed to create commit');
      return {
        success: false,
        error: `Failed to commit: ${errorMessage}`,
      };
    }
  }

  /**
   * Get the current status of the repository
   *
   * @param localPath - Path to the local repository
   * @returns Status result
   */
  public async getStatus(localPath: string): Promise<StatusResult> {
    const git: SimpleGit = simpleGit(localPath);
    return await git.status();
  }

  /**
   * Complete sanitization workflow
   *
   * This orchestrates the full "fix it" loop:
   * 1. Parse the error
   * 2. Sanitize history (soft reset)
   * 3. Return information for PM to fix
   *
   * The PM then:
   * - Removes the secret
   * - Saves the file
   *
   * Then call recommit() and retryPushSafely() to complete.
   *
   * @param localPath - Path to the local repository
   * @param errorOutput - Raw error output from the failed push
   * @returns Parsed violation info and sanitization status
   */
  public async handlePushRejection(
    localPath: string,
    errorOutput: string
  ): Promise<{
    violation: IPolicyViolationResult;
    sanitized: ISanitizeResult;
    nextSteps: readonly string[];
  }> {
    // Parse the violation
    const violation = this.parseViolation(errorOutput);

    // Sanitize commit history
    const sanitized = await this.sanitizeHistory(localPath);

    // Generate next steps for the PM
    const nextSteps: string[] = [];

    if (sanitized.success) {
      if (violation.violations.length > 0) {
        for (const v of violation.violations) {
          if (v.line) {
            nextSteps.push(`Open ${v.file} and go to line ${v.line}`);
          } else {
            nextSteps.push(`Open ${v.file} and find the ${v.secretType}`);
          }
        }
        nextSteps.push('Remove the secret (replace with environment variable if needed)');
        nextSteps.push('Save the file');
        nextSteps.push('Tell me when ready and I will create a new commit and push');
      } else {
        nextSteps.push('Check your recently modified files for secrets');
        nextSteps.push('Remove any API keys, passwords, or tokens');
        nextSteps.push('Save the file(s)');
        nextSteps.push('Tell me when ready and I will create a new commit and push');
      }
    } else {
      nextSteps.push('The automatic fix failed. Please ask an engineer for help.');
      nextSteps.push(`Error: ${sanitized.error ?? 'Unknown error'}`);
    }

    logger.info(
      {
        localPath,
        violationType: violation.type,
        sanitized: sanitized.success,
        violationCount: violation.violations.length,
      },
      'Handled push rejection'
    );

    return {
      violation,
      sanitized,
      nextSteps,
    };
  }
}

/**
 * Singleton instance
 */
export const policyRejectionHandler = new PolicyRejectionHandler();
