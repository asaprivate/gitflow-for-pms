/**
 * Smart Git Operation MCP Tools
 *
 * This module provides high-level "PM-friendly" MCP tools that abstract
 * complex git commands into simple actions:
 *
 * - get_repo_status: Get current repository status with clean formatting
 * - save_changes: Smart commit that auto-creates branches when on main/master
 *
 * These tools integrate with:
 * - GitService for local git operations
 * - RepositoryRepository for repo metadata
 * - SessionRepository for session tracking
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { GitService } from '../../services/GitService.js';
import { ErrorTranslator } from '../../services/ErrorTranslator.js';
import { GitHubAPIService } from '../../services/GitHubAPIService.js';
import { authService } from '../../services/AuthService.js';
import { repositoryRepository } from '../../repositories/RepositoryRepository.js';
import { sessionRepository } from '../../repositories/SessionRepository.js';
import { userRepository } from '../../repositories/UserRepository.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger({ module: 'GitOperationTools' });

// ============================================================================
// Input Schemas
// ============================================================================

/**
 * Input schema for get_repo_status tool
 */
const GetRepoStatusInputSchema = z.object({
  userId: z.string().uuid().describe('User ID for authentication'),
  repoId: z
    .string()
    .uuid()
    .optional()
    .describe('Repository ID (optional - will use active session if not provided)'),
  localPath: z
    .string()
    .optional()
    .describe('Local filesystem path to the repository (alternative to repoId)'),
});

/**
 * Input schema for save_changes tool
 */
const SaveChangesInputSchema = z.object({
  userId: z.string().uuid().describe('User ID for authentication'),
  message: z
    .string()
    .min(1)
    .max(500)
    .describe('Commit message describing the changes'),
  repoId: z
    .string()
    .uuid()
    .optional()
    .describe('Repository ID (optional - will use active session if not provided)'),
});

/**
 * Input schema for push_for_review tool
 */
const PushForReviewInputSchema = z.object({
  userId: z.string().uuid().describe('User ID for authentication'),
  title: z
    .string()
    .max(256)
    .optional()
    .describe('Pull request title (defaults to session task description)'),
  description: z
    .string()
    .max(65536)
    .optional()
    .describe('Pull request description/body'),
  isDraft: z
    .boolean()
    .optional()
    .describe('Create as draft PR (default: false)'),
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
// Helper Functions
// ============================================================================

/**
 * Generate a branch name from a commit message
 * Converts "Add Stripe Express Checkout" to "feature/add-stripe-express-checkout"
 */
function generateBranchName(message: string): string {
  const sanitized = message
    .toLowerCase()
    // Remove special characters except spaces and hyphens
    .replace(/[^a-z0-9\s-]/g, '')
    // Replace multiple spaces with single space
    .replace(/\s+/g, ' ')
    // Trim whitespace
    .trim()
    // Replace spaces with hyphens
    .replace(/\s/g, '-')
    // Limit length
    .slice(0, 50);

  // Add feature/ prefix if not already present
  if (sanitized.startsWith('feature-') || sanitized.startsWith('fix-') || sanitized.startsWith('hotfix-')) {
    return sanitized.replace('-', '/');
  }

  return `feature/${sanitized}`;
}

/**
 * Check if a branch is a protected branch (main/master)
 */
function isProtectedBranch(branchName: string): boolean {
  const protectedBranches = ['main', 'master', 'develop', 'development'];
  return protectedBranches.includes(branchName.toLowerCase());
}

/**
 * Resolve the repository local path from various inputs
 */
async function resolveRepoContext(
  userId: string,
  repoId?: string,
  localPath?: string
): Promise<{
  localPath: string;
  repoId: string;
  sessionId: string | null;
} | null> {
  // If local path is provided directly, find the repo record
  if (localPath) {
    const repo = await repositoryRepository.findByLocalPath(localPath);
    if (repo && repo.userId === userId) {
      const session = await sessionRepository.findActiveByRepoId(repo.id);
      return {
        localPath: repo.localPath,
        repoId: repo.id,
        sessionId: session?.id ?? null,
      };
    }
    // Return just the path if no DB record (for manual repos)
    return {
      localPath,
      repoId: '',
      sessionId: null,
    };
  }

  // If repo ID is provided, look it up
  if (repoId) {
    const repo = await repositoryRepository.findById(repoId);
    if (repo && repo.userId === userId && repo.isCloned) {
      const session = await sessionRepository.findActiveByRepoId(repo.id);
      return {
        localPath: repo.localPath,
        repoId: repo.id,
        sessionId: session?.id ?? null,
      };
    }
    return null;
  }

  // Try to find from active session
  const activeSession = await sessionRepository.findActiveByUserId(userId);
  if (activeSession) {
    const repo = await repositoryRepository.findById(activeSession.repoId);
    if (repo && repo.isCloned) {
      return {
        localPath: repo.localPath,
        repoId: repo.id,
        sessionId: activeSession.id,
      };
    }
  }

  return null;
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register all Smart Git Operation tools with the MCP server
 *
 * @param server - The MCP server instance
 */
export function registerGitOperationTools(server: McpServer): void {
  logger.info('Registering Smart Git Operation tools');

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 1: get_repo_status
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'get_repo_status',
    'Get the current status of your repository. Shows modified files, staged changes, and current branch. Automatically finds your active repository if no repo_id is provided.',
    GetRepoStatusInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { userId, repoId, localPath } = args as z.infer<typeof GetRepoStatusInputSchema>;

      logger.info({ userId, repoId, localPath }, 'get_repo_status tool called');

      try {
        // Verify user exists
        const user = await userRepository.findById(userId);
        if (!user) {
          return successResponse(
            [
              '🔒 **Not Authenticated**',
              '',
              'User not found. Please authenticate with GitHub first.',
              '',
              '_Use `authenticate_github` to connect your GitHub account._',
            ].join('\n')
          );
        }

        // Resolve repository context
        const context = await resolveRepoContext(userId, repoId, localPath);
        if (!context) {
          return successResponse(
            [
              '📂 **No Repository Found**',
              '',
              'Could not find an active repository to check.',
              '',
              'Please either:',
              '- Provide a `repo_id` parameter',
              '- Provide a `local_path` to the repository',
              '- Clone a repository first using `clone_and_setup_repo`',
              '',
              '_Use `list_repositories` to see available repositories._',
            ].join('\n')
          );
        }

        // Get git status
        const gitService = GitService.forExistingRepo(userId, context.localPath);
        const status = await gitService.status();

        // Build response
        const lines = ['📊 **Repository Status**', ''];

        // Branch info
        lines.push(`**Branch:** \`${status.currentBranch}\``);

        // Protected branch warning
        if (isProtectedBranch(status.currentBranch)) {
          lines.push(`⚠️ _You are on the protected \`${status.currentBranch}\` branch._`);
          lines.push(`_A new branch will be created when you save changes._`);
        }

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
          lines.push('✨ **Working directory is clean** - no changes to save');
        } else {
          const totalChanges =
            status.modifiedFiles.length +
            status.stagedFiles.length +
            status.untrackedFiles.length;

          lines.push(`📝 **${totalChanges} file(s) with changes**`);
          lines.push('');

          // Modified files
          if (status.modifiedFiles.length > 0) {
            lines.push(`**Modified (${status.modifiedFiles.length}):**`);
            for (const file of status.modifiedFiles.slice(0, 10)) {
              lines.push(`  • ${file}`);
            }
            if (status.modifiedFiles.length > 10) {
              lines.push(`  ... and ${status.modifiedFiles.length - 10} more`);
            }
            lines.push('');
          }

          // Staged files
          if (status.stagedFiles.length > 0) {
            lines.push(`**Staged for commit (${status.stagedFiles.length}):**`);
            for (const file of status.stagedFiles.slice(0, 10)) {
              lines.push(`  ✓ ${file}`);
            }
            if (status.stagedFiles.length > 10) {
              lines.push(`  ... and ${status.stagedFiles.length - 10} more`);
            }
            lines.push('');
          }

          // Untracked files
          if (status.untrackedFiles.length > 0) {
            lines.push(`**New files (${status.untrackedFiles.length}):**`);
            for (const file of status.untrackedFiles.slice(0, 5)) {
              lines.push(`  + ${file}`);
            }
            if (status.untrackedFiles.length > 5) {
              lines.push(`  ... and ${status.untrackedFiles.length - 5} more`);
            }
            lines.push('');
          }

          lines.push('_Use `save_changes` to commit your changes._');
        }

        // Return structured JSON data as well
        const jsonData = {
          current_branch: status.currentBranch,
          is_clean: status.isClean,
          modified_files: status.modifiedFiles,
          staged_files: status.stagedFiles,
          untracked_files: status.untrackedFiles,
          ahead: status.ahead,
          behind: status.behind,
        };

        lines.push('');
        lines.push('---');
        lines.push('```json');
        lines.push(JSON.stringify(jsonData, null, 2));
        lines.push('```');

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, userId, repoId }, 'get_repo_status failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 2: save_changes
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'save_changes',
    'Save your changes with a commit. If you are on main/master, a new feature branch will be automatically created. This is the "smart commit" that handles branching for you.',
    SaveChangesInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { userId, message, repoId } = args as z.infer<typeof SaveChangesInputSchema>;

      logger.info({ userId, messageLength: message.length, repoId }, 'save_changes tool called');

      try {
        // Verify user exists
        const user = await userRepository.findById(userId);
        if (!user) {
          return successResponse(
            [
              '🔒 **Not Authenticated**',
              '',
              'User not found. Please authenticate with GitHub first.',
              '',
              '_Use `authenticate_github` to connect your GitHub account._',
            ].join('\n')
          );
        }

        // Resolve repository context
        const context = await resolveRepoContext(userId, repoId);
        if (!context || !context.repoId) {
          return successResponse(
            [
              '📂 **No Repository Found**',
              '',
              'Could not find an active repository to save changes.',
              '',
              'Please either:',
              '- Provide a `repo_id` parameter',
              '- Clone a repository first using `clone_and_setup_repo`',
              '',
              '_Use `list_repositories` to see available repositories._',
            ].join('\n')
          );
        }

        // Get git service
        const gitService = GitService.forExistingRepo(userId, context.localPath);

        // Step 1: Get current status
        const status = await gitService.status();

        // Check if there are changes to commit
        if (status.isClean) {
          return successResponse(
            [
              '✨ **No Changes to Save**',
              '',
              `Your repository is already clean on branch \`${status.currentBranch}\`.`,
              '',
              'Make some changes to your files, then try again.',
            ].join('\n')
          );
        }

        const lines: string[] = [];
        let branchCreated = false;
        let newBranchName = status.currentBranch;

        // Step 2: Safety Check - Create branch if on protected branch
        if (isProtectedBranch(status.currentBranch)) {
          newBranchName = generateBranchName(message);
          
          logger.info(
            { currentBranch: status.currentBranch, newBranch: newBranchName },
            'Creating new branch from protected branch'
          );

          // Create and checkout the new branch
          await gitService.createBranch(newBranchName, status.currentBranch, true);
          branchCreated = true;

          lines.push('🌿 **New Branch Created**');
          lines.push('');
          lines.push(
            `You were on \`${status.currentBranch}\`, so a new branch was created:`
          );
          lines.push(`**Branch:** \`${newBranchName}\``);
          lines.push('');
        }

        // Step 3: Stage all changes
        await gitService.add('.');

        // Step 4: Commit changes
        const commitResult = await gitService.commit({ message });

        // Step 5: Update session if exists
        if (context.sessionId) {
          // Update session with new branch name and increment commits
          await sessionRepository.update(context.sessionId, {
            currentBranch: newBranchName,
            lastAction: 'commit',
          });
          await sessionRepository.incrementCommits(context.sessionId);

          logger.info(
            { sessionId: context.sessionId, branch: newBranchName },
            'Session updated with commit'
          );
        }

        // Update repository current branch
        await repositoryRepository.updateCurrentBranch(context.repoId, newBranchName);

        // Build success response
        if (!branchCreated) {
          lines.push('✅ **Changes Saved Successfully**');
          lines.push('');
        } else {
          lines.push('✅ **Changes Committed to New Branch**');
          lines.push('');
        }

        lines.push(`**Commit:** \`${commitResult.commitHash.substring(0, 7)}\``);
        lines.push(`**Branch:** \`${newBranchName}\``);
        lines.push(`**Message:** ${message}`);
        lines.push('');
        lines.push('**Changes:**');
        lines.push(`  • ${commitResult.filesChanged} file(s) changed`);
        lines.push(`  • +${commitResult.insertions} insertions`);
        lines.push(`  • -${commitResult.deletions} deletions`);
        lines.push('');

        if (branchCreated) {
          lines.push(
            '_Your changes are saved on a feature branch. Use `git_push` to publish._'
          );
        } else {
          lines.push('_Use `git_push` to publish your changes to GitHub._');
        }

        // Return structured JSON data as well
        const jsonData = {
          status: 'committed',
          branch: newBranchName,
          commit_hash: commitResult.commitHash,
          files_changed: commitResult.filesChanged,
          insertions: commitResult.insertions,
          deletions: commitResult.deletions,
          branch_created: branchCreated,
        };

        lines.push('');
        lines.push('---');
        lines.push('```json');
        lines.push(JSON.stringify(jsonData, null, 2));
        lines.push('```');

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, userId, repoId }, 'save_changes failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 3: push_for_review
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'push_for_review',
    'Push your changes and create a pull request for review. This is the "I\'m done, send it for review" action. Automatically pushes to remote and creates a PR with a link you can share.',
    PushForReviewInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { userId, title, description, isDraft } = args as z.infer<
        typeof PushForReviewInputSchema
      >;

      logger.info({ userId, hasTitle: !!title, isDraft }, 'push_for_review tool called');

      try {
        // Step 1: Verify user exists and get access token
        const user = await userRepository.findById(userId);
        if (!user) {
          return successResponse(
            [
              '🔒 **Not Authenticated**',
              '',
              'User not found. Please authenticate with GitHub first.',
              '',
              '_Use `authenticate_github` to connect your GitHub account._',
            ].join('\n')
          );
        }

        const accessToken = await authService.getAccessToken(userId);
        if (!accessToken) {
          return successResponse(
            [
              '🔒 **Not Authenticated**',
              '',
              'GitHub authentication required to create pull requests.',
              '',
              '_Use `authenticate_github` to connect your GitHub account._',
            ].join('\n')
          );
        }

        // Step 2: Get active session
        const activeSession = await sessionRepository.findActiveByUserId(userId);
        if (!activeSession) {
          return successResponse(
            [
              '📋 **No Active Session**',
              '',
              'You need an active work session to push for review.',
              '',
              'Please start working on a repository first:',
              '- Use `clone_and_setup_repo` to clone a repository',
              '- Use `save_changes` to commit your work',
              '',
              '_Then try `push_for_review` again._',
            ].join('\n')
          );
        }

        // Step 3: Get repository details
        const repository = await repositoryRepository.findById(activeSession.repoId);
        if (!repository || !repository.isCloned) {
          return successResponse(
            [
              '📂 **Repository Not Found**',
              '',
              'The repository for your active session could not be found.',
              '',
              '_Use `clone_and_setup_repo` to clone a repository._',
            ].join('\n')
          );
        }

        // Step 4: Safety check - cannot push from main/master
        const currentBranch = activeSession.currentBranch;
        if (isProtectedBranch(currentBranch)) {
          return successResponse(
            [
              '⚠️ **Cannot Create PR from Protected Branch**',
              '',
              `You are on the \`${currentBranch}\` branch.`,
              'Pull requests should be created from feature branches, not from main/master.',
              '',
              '**What to do:**',
              '1. Use `save_changes` to commit your work (it will create a feature branch)',
              '2. Then use `push_for_review` to create the PR',
              '',
              '_This keeps your main branch clean and your work organized._',
            ].join('\n')
          );
        }

        // Step 5: Check if there are unpushed commits or local changes
        const gitService = GitService.forExistingRepo(userId, repository.localPath);
        const status = await gitService.status();

        // If there are uncommitted changes, prompt to save first
        if (!status.isClean) {
          return successResponse(
            [
              '📝 **Uncommitted Changes Detected**',
              '',
              'You have uncommitted changes that won\'t be included in the PR.',
              '',
              `**Unsaved files (${status.modifiedFiles.length + status.untrackedFiles.length}):**`,
              ...status.modifiedFiles.slice(0, 5).map((f) => `  • ${f}`),
              ...status.untrackedFiles.slice(0, 3).map((f) => `  + ${f}`),
              '',
              '**What to do:**',
              '1. Use `save_changes` to commit these changes first',
              '2. Then use `push_for_review` to create the PR',
              '',
              '_Or if you want to exclude these changes, stash them first._',
            ].join('\n')
          );
        }

        // Step 6: Push to remote
        logger.info(
          { userId, branch: currentBranch, repo: repository.githubName },
          'Pushing branch to remote'
        );

        let pushResult;
        try {
          pushResult = await gitService.push(currentBranch, { setUpstream: true });

          // Check if push was rejected due to policy violation
          if ('rejected' in pushResult && pushResult.rejected) {
            return successResponse(
              [
                '🛑 **Push Blocked by GitHub**',
                '',
                '⚠️ **Security Alert:** GitHub detected sensitive information in your code.',
                '',
                'Your push was blocked because secrets were detected.',
                '',
                '**What to do:**',
                '1. Remove the sensitive information from your code',
                '2. Use `save_changes` to commit the fix',
                '3. Try `push_for_review` again',
                '',
                '_Check your files for API keys, passwords, or tokens._',
              ].join('\n')
            );
          }
        } catch (pushError) {
          // Handle specific push errors
          const errorMessage =
            pushError instanceof Error ? pushError.message : String(pushError);

          // Check for "remote contains work you do not have" error
          if (
            errorMessage.includes('remote contains work') ||
            errorMessage.includes('fetch first') ||
            errorMessage.includes('non-fast-forward')
          ) {
            return successResponse(
              [
                '⚠️ **Push Failed - Remote Has New Changes**',
                '',
                'Someone else has pushed changes to this branch.',
                '',
                '**What to do:**',
                '1. Use `git_pull` to get the latest changes',
                '2. Resolve any conflicts if needed',
                '3. Try `push_for_review` again',
                '',
                '_This ensures your PR includes all the latest work._',
              ].join('\n')
            );
          }

          // Re-throw other errors
          throw pushError;
        }

        logger.info(
          { userId, branch: currentBranch },
          'Branch pushed successfully, creating PR'
        );

        // Step 7: Create Pull Request
        const githubService = new GitHubAPIService(accessToken);

        // Determine PR title
        const prTitle =
          title ||
          activeSession.taskDescription ||
          `Feature: ${currentBranch.replace(/^(feature|fix|hotfix)\//, '')}`;

        // Build PR body
        const prBodyParts = [description || ''];
        prBodyParts.push('');
        prBodyParts.push('---');
        prBodyParts.push('*Created via GitFlow MCP*');

        const prBody = prBodyParts.join('\n').trim();

        let pr;
        try {
          pr = await githubService.createPullRequest({
            owner: repository.githubOrg,
            repo: repository.githubName,
            title: prTitle,
            head: currentBranch,
            body: prBody,
            draft: isDraft ?? false,
          });
        } catch (prError) {
          // Handle PR creation errors gracefully
          const errorMessage =
            prError instanceof Error ? prError.message : String(prError);

          // Check if PR already exists
          if (errorMessage.includes('already exists')) {
            // Try to find the existing PR
            try {
              const existingPRs = await githubService.listPullRequests(
                repository.githubOrg,
                repository.githubName,
                'open'
              );
              const matchingPR = existingPRs.find(
                (p) => p.headBranch === currentBranch
              );

              if (matchingPR) {
                return successResponse(
                  [
                    '📋 **Pull Request Already Exists**',
                    '',
                    `A pull request for branch \`${currentBranch}\` already exists.`,
                    '',
                    `**PR #${matchingPR.number}:** ${matchingPR.title}`,
                    '',
                    `🔗 **View PR:** ${matchingPR.url}`,
                    '',
                    'Your latest changes have been pushed to this PR.',
                  ].join('\n')
                );
              }
            } catch {
              // Ignore errors when trying to find existing PR
            }
          }

          // Re-throw if we couldn't handle it
          throw prError;
        }

        // Step 8: Update session with PR details
        await sessionRepository.updatePR(
          activeSession.id,
          pr.id,
          pr.number,
          pr.url
        );

        logger.info(
          { userId, prNumber: pr.number, prUrl: pr.url },
          'Pull request created and session updated'
        );

        // Build success response
        const lines = [
          isDraft ? '📝 **Draft Pull Request Created**' : '🎉 **Pull Request Created**',
          '',
          `**Title:** ${prTitle}`,
          `**Branch:** \`${currentBranch}\` → \`${pr.baseBranch}\``,
          `**PR Number:** #${pr.number}`,
          '',
          `🔗 **View PR:** ${pr.url}`,
          '',
        ];

        if (isDraft) {
          lines.push('_This is a draft PR. Mark it as ready when you want reviews._');
        } else {
          lines.push('_Share this link with your team for review!_');
        }

        // Return structured JSON data as well
        const jsonData = {
          status: 'success',
          pr_number: pr.number,
          pr_url: pr.url,
          branch: currentBranch,
          title: prTitle,
          is_draft: isDraft ?? false,
        };

        lines.push('');
        lines.push('---');
        lines.push('```json');
        lines.push(JSON.stringify(jsonData, null, 2));
        lines.push('```');

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, userId }, 'push_for_review failed');
        return errorResponse(error);
      }
    }
  );

  logger.info('Smart Git Operation tools registered successfully');
}
