/**
 * Git Operation MCP Tools
 *
 * This module provides MCP tools for local Git operations:
 * - git_status: Get repository status
 * - git_commit: Stage and commit changes
 * - git_push: Push to remote (with policy rejection handling)
 * - git_pull: Pull from remote (with conflict handling)
 * - git_clone: Clone a repository
 * - git_checkout: Switch or create branches
 *
 * These tools wrap the GitService methods and use ErrorTranslator
 * to provide user-friendly error messages.
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { GitService, createGitService } from '../../services/GitService.js';
import { ErrorTranslator } from '../../services/ErrorTranslator.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger({ module: 'GitTools' });

// ============================================================================
// Input Schemas
// ============================================================================

/**
 * Input schema for git_status tool
 */
const GitStatusInputSchema = z.object({
  repoPath: z.string().describe('Path to the local repository'),
  userId: z.string().uuid().describe('User ID for authentication context'),
});

/**
 * Input schema for git_commit tool
 */
const GitCommitInputSchema = z.object({
  repoPath: z.string().describe('Path to the local repository'),
  message: z.string().min(1).describe('Commit message describing the changes'),
  userId: z.string().uuid().describe('User ID for authentication context'),
  files: z
    .array(z.string())
    .optional()
    .describe('Specific files to commit (defaults to all changed files)'),
});

/**
 * Input schema for git_push tool
 */
const GitPushInputSchema = z.object({
  repoPath: z.string().describe('Path to the local repository'),
  branch: z.string().describe('Branch name to push'),
  userId: z.string().uuid().describe('User ID for authentication'),
  setUpstream: z
    .boolean()
    .optional()
    .describe('Set upstream tracking for new branches'),
});

/**
 * Input schema for git_pull tool
 */
const GitPullInputSchema = z.object({
  repoPath: z.string().describe('Path to the local repository'),
  userId: z.string().uuid().describe('User ID for authentication'),
  rebase: z.boolean().optional().describe('Use rebase instead of merge'),
});

/**
 * Input schema for git_clone tool
 */
const GitCloneInputSchema = z.object({
  repoUrl: z
    .string()
    .url()
    .describe('GitHub repository URL (https://github.com/owner/repo.git)'),
  localPath: z.string().describe('Local path where the repository will be cloned'),
  userId: z.string().uuid().describe('User ID for authentication'),
  branch: z.string().optional().describe('Specific branch to clone'),
  depth: z.number().optional().describe('Shallow clone depth (for faster cloning)'),
});

/**
 * Input schema for git_checkout tool
 */
const GitCheckoutInputSchema = z.object({
  repoPath: z.string().describe('Path to the local repository'),
  branch: z.string().describe('Branch name to checkout or create'),
  userId: z.string().uuid().describe('User ID for authentication context'),
  create: z
    .boolean()
    .optional()
    .describe('Create a new branch if it does not exist'),
  fromBranch: z
    .string()
    .optional()
    .describe('Base branch to create from (only used with create=true)'),
});

// ============================================================================
// Tool Response Helpers
// ============================================================================

/**
 * Create a successful tool response
 */
function successResponse(
  text: string
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Create an error tool response from a translated error
 */
function errorResponse(
  error: unknown
): { content: Array<{ type: 'text'; text: string }> } {
  const translated = ErrorTranslator.translate(error);

  const lines = [
    `❌ **${translated.severity === 'critical' ? 'Critical Error' : 'Error'}**`,
    '',
    translated.userMessage,
    '',
  ];

  if (translated.affectedFiles && translated.affectedFiles.length > 0) {
    lines.push('**Affected Files:**');
    for (const file of translated.affectedFiles.slice(0, 5)) {
      lines.push(`- ${file}`);
    }
    if (translated.affectedFiles.length > 5) {
      lines.push(`- ... and ${translated.affectedFiles.length - 5} more`);
    }
    lines.push('');
  }

  if (translated.suggestedActions.length > 0) {
    lines.push('**Suggested Actions:**');
    for (const action of translated.suggestedActions) {
      lines.push(`- ${action.label}${action.description ? `: ${action.description}` : ''}`);
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register all Git operation tools with the MCP server
 *
 * @param server - The MCP server instance
 */
export function registerGitTools(server: McpServer): void {
  logger.info('Registering Git operation tools');

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 1: git_status
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'git_status',
    'Get the current status of a Git repository. Shows modified files, staged changes, current branch, and sync status with remote.',
    GitStatusInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { repoPath, userId } = args as z.infer<typeof GitStatusInputSchema>;

      logger.info({ repoPath, userId }, 'git_status tool called');

      try {
        const gitService = createGitService(userId, repoPath);
        const status = await gitService.status();

        const lines = ['📊 **Repository Status**', ''];

        // Branch info
        lines.push(`**Branch:** \`${status.currentBranch}\``);

        // Sync status
        if (status.ahead > 0 || status.behind > 0) {
          if (status.ahead > 0 && status.behind > 0) {
            lines.push(
              `**Sync:** ⚠️ ${status.ahead} commit(s) ahead, ${status.behind} behind remote`
            );
          } else if (status.ahead > 0) {
            lines.push(`**Sync:** ⬆️ ${status.ahead} commit(s) ready to push`);
          } else {
            lines.push(`**Sync:** ⬇️ ${status.behind} commit(s) behind remote`);
          }
        } else {
          lines.push('**Sync:** ✅ Up to date with remote');
        }

        lines.push('');

        // Files status
        if (status.isClean) {
          lines.push('✨ **Working directory is clean** - no changes to commit');
        } else {
          // Modified files
          if (status.modifiedFiles.length > 0) {
            lines.push(`**Modified Files (${status.modifiedFiles.length}):**`);
            for (const file of status.modifiedFiles.slice(0, 10)) {
              lines.push(`  📝 ${file}`);
            }
            if (status.modifiedFiles.length > 10) {
              lines.push(`  ... and ${status.modifiedFiles.length - 10} more`);
            }
            lines.push('');
          }

          // Staged files
          if (status.stagedFiles.length > 0) {
            lines.push(`**Staged Files (${status.stagedFiles.length}):**`);
            for (const file of status.stagedFiles.slice(0, 10)) {
              lines.push(`  ✅ ${file}`);
            }
            if (status.stagedFiles.length > 10) {
              lines.push(`  ... and ${status.stagedFiles.length - 10} more`);
            }
            lines.push('');
          }

          // Untracked files
          if (status.untrackedFiles.length > 0) {
            lines.push(`**New Files (${status.untrackedFiles.length}):**`);
            for (const file of status.untrackedFiles.slice(0, 5)) {
              lines.push(`  ➕ ${file}`);
            }
            if (status.untrackedFiles.length > 5) {
              lines.push(`  ... and ${status.untrackedFiles.length - 5} more`);
            }
          }
        }

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, repoPath }, 'git_status failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 2: git_commit
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'git_commit',
    'Stage all changes and create a commit with the provided message. Optionally specify specific files to commit.',
    GitCommitInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { repoPath, message, userId, files } = args as z.infer<
        typeof GitCommitInputSchema
      >;

      logger.info({ repoPath, userId, messageLength: message.length }, 'git_commit tool called');

      try {
        const gitService = createGitService(userId, repoPath);

        // Stage files
        if (files && files.length > 0) {
          await gitService.add(files);
        } else {
          await gitService.add('.');
        }

        // Create commit - only pass files if they are defined
        const commitOptions = files && files.length > 0 
          ? { message, files } 
          : { message };
        const result = await gitService.commit(commitOptions);

        const lines = [
          '✅ **Commit Created Successfully**',
          '',
          `**Commit:** \`${result.commitHash.substring(0, 7)}\``,
          `**Message:** ${result.message}`,
          '',
          `**Changes:**`,
          `- Files changed: ${result.filesChanged}`,
          `- Lines added: +${result.insertions}`,
          `- Lines removed: -${result.deletions}`,
          '',
          '_Use `git_push` to publish your changes to GitHub._',
        ];

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, repoPath }, 'git_commit failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 3: git_push
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'git_push',
    'Push local commits to the remote repository. Handles push protection violations (secrets detected) and provides recovery guidance.',
    GitPushInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { repoPath, branch, userId, setUpstream } = args as z.infer<
        typeof GitPushInputSchema
      >;

      logger.info({ repoPath, branch, userId }, 'git_push tool called');

      try {
        const gitService = createGitService(userId, repoPath);

        const result = await gitService.push(branch, {
          setUpstream: setUpstream ?? false,
        });

        // Check if push was rejected due to policy violation
        if ('rejected' in result && result.rejected) {
          const lines = [
            '🛑 **Push Blocked by GitHub**',
            '',
            '⚠️ **Security Alert:** GitHub detected sensitive information in your code.',
            '',
            '**Violation Details:**',
            `- Type: ${result.violation.type}`,
          ];

          if (result.violation.violations.length > 0) {
            lines.push('', '**Secrets Detected:**');
            for (const violation of result.violation.violations) {
              const lineInfo = violation.line !== null ? ` (line ${violation.line})` : '';
              lines.push(`- ${violation.secretType} in \`${violation.file}\`${lineInfo}`);
            }
          }

          lines.push('', '**What Happened:**');
          lines.push('Your changes have been automatically cleaned from git history.');
          lines.push('The files with secrets are now in your working directory (uncommitted).');

          lines.push('', '**Next Steps:**');
          for (const step of result.nextSteps) {
            lines.push(`- ${step}`);
          }

          lines.push('', '_After fixing, use `git_commit` and `git_push` to try again._');

          return successResponse(lines.join('\n'));
        }

        // Successful push - narrow type to IGitPushResult
        const pushResult = result as { success: boolean; remoteUrl: string; branch: string };
        const lines = [
          '✅ **Push Successful**',
          '',
          `**Branch:** \`${pushResult.branch}\``,
          `**Remote:** ${pushResult.remoteUrl}`,
          '',
          '_Your changes are now on GitHub!_',
        ];

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, repoPath, branch }, 'git_push failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 4: git_pull
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'git_pull',
    'Pull latest changes from the remote repository. Handles merge conflicts and provides guidance for resolution.',
    GitPullInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { repoPath, userId, rebase } = args as z.infer<typeof GitPullInputSchema>;

      logger.info({ repoPath, userId, rebase }, 'git_pull tool called');

      try {
        const gitService = createGitService(userId, repoPath);

        const result = await gitService.pull({
          rebase: rebase ?? false,
        });

        // Check for merge conflicts
        if (result.hasConflicts) {
          const lines = [
            '⚠️ **Merge Conflicts Detected**',
            '',
            'The pull was successful, but there are conflicts that need to be resolved.',
            '',
            `**Conflicting Files (${result.conflictFiles.length}):**`,
          ];

          for (const file of result.conflictFiles) {
            lines.push(`- ❌ ${file}`);
          }

          lines.push('');
          lines.push('**What This Means:**');
          lines.push(
            'Both you and someone else changed the same parts of these files.'
          );
          lines.push('');
          lines.push('**How to Fix:**');
          lines.push('1. Open each conflicting file in your editor');
          lines.push('2. Look for `<<<<<<<` and `>>>>>>>` markers');
          lines.push('3. Choose which changes to keep');
          lines.push('4. Remove the conflict markers');
          lines.push('5. Use `git_commit` to save the resolution');
          lines.push('');
          lines.push('_Ask an engineer for help if the conflicts are complex._');

          return successResponse(lines.join('\n'));
        }

        // Successful pull
        const lines = [
          '✅ **Pull Successful**',
          '',
          result.newCommits > 0
            ? `**Downloaded:** ${result.newCommits} new commit(s)`
            : '**Status:** Already up to date',
          '',
          '_Your local repository is now synced with GitHub._',
        ];

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, repoPath }, 'git_pull failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 5: git_clone
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'git_clone',
    'Clone a GitHub repository to your local machine. Requires authentication for private repositories.',
    GitCloneInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { repoUrl, localPath, userId, branch, depth } = args as z.infer<
        typeof GitCloneInputSchema
      >;

      logger.info({ repoUrl, localPath, userId }, 'git_clone tool called');

      try {
        // Create a new GitService for the clone operation
        const gitService = new GitService({
          userId,
          localPath,
          remoteUrl: repoUrl,
        });

        // Check if already cloned
        if (gitService.isCloned()) {
          return successResponse(
            [
              '📁 **Repository Already Exists**',
              '',
              `This repository is already cloned at:`,
              `\`${localPath}\``,
              '',
              '_Use `git_pull` to get the latest changes._',
            ].join('\n')
          );
        }

        // Build clone options - only include defined values
        const cloneOptions: { branch?: string; depth?: number } = {};
        if (branch !== undefined) {
          cloneOptions.branch = branch;
        }
        if (depth !== undefined) {
          cloneOptions.depth = depth;
        }

        // Perform clone
        const clonedPath = await gitService.clone(repoUrl, cloneOptions);

        const lines = [
          '✅ **Repository Cloned Successfully**',
          '',
          `**Location:** \`${clonedPath}\``,
          `**Source:** ${repoUrl}`,
        ];

        if (branch) {
          lines.push(`**Branch:** \`${branch}\``);
        }

        lines.push('');
        lines.push('_You can now start editing files in this repository._');

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, repoUrl, localPath }, 'git_clone failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 6: git_checkout
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'git_checkout',
    'Switch to a different branch or create a new branch. Use create=true to create a new branch.',
    GitCheckoutInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { repoPath, branch, userId, create, fromBranch } = args as z.infer<
        typeof GitCheckoutInputSchema
      >;

      logger.info({ repoPath, branch, userId, create }, 'git_checkout tool called');

      try {
        const gitService = createGitService(userId, repoPath);

        if (create) {
          // Create a new branch
          await gitService.createBranch(branch, fromBranch, true);

          const lines = [
            '✅ **New Branch Created**',
            '',
            `**Branch:** \`${branch}\``,
          ];

          if (fromBranch) {
            lines.push(`**Based on:** \`${fromBranch}\``);
          }

          lines.push('');
          lines.push('You are now on the new branch and ready to make changes.');
          lines.push('');
          lines.push('_Use `git_commit` when you want to save your work._');

          return successResponse(lines.join('\n'));
        } else {
          // Switch to existing branch
          await gitService.checkout(branch);

          // Get status after checkout
          const status = await gitService.status();

          const lines = [
            '✅ **Branch Switched**',
            '',
            `**Current Branch:** \`${branch}\``,
          ];

          if (!status.isClean) {
            lines.push('');
            lines.push(
              `⚠️ Note: You have ${status.modifiedFiles.length + status.untrackedFiles.length} uncommitted changes.`
            );
          }

          return successResponse(lines.join('\n'));
        }
      } catch (error) {
        logger.error({ error, repoPath, branch }, 'git_checkout failed');
        return errorResponse(error);
      }
    }
  );

  logger.info('Git operation tools registered successfully');
}
