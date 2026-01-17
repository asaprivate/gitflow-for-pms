/**
 * Repository MCP Tools
 *
 * This module provides MCP tools for repository management:
 * - list_repositories: List accessible GitHub repositories for the authenticated user
 * - clone_and_setup_repo: Clone a repository locally and set up the session
 *
 * These tools integrate GitHubAPIService for listing, GitService for cloning,
 * and persist records in RepositoryRepository and SessionRepository.
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { authService } from '../../services/AuthService.js';
import { GitHubAPIService } from '../../services/GitHubAPIService.js';
import { GitService, generateLocalPath } from '../../services/GitService.js';
import { ErrorTranslator } from '../../services/ErrorTranslator.js';
import { userRepository } from '../../repositories/UserRepository.js';
import { repositoryRepository } from '../../repositories/RepositoryRepository.js';
import { sessionRepository } from '../../repositories/SessionRepository.js';
import { TIER_LIMITS } from '../../types/index.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger({ module: 'RepositoryTools' });

// ============================================================================
// Input Schemas
// ============================================================================

/**
 * Input schema for list_repositories tool
 */
const ListRepositoriesInputSchema = z.object({
  userId: z.string().uuid().describe('User ID for authentication'),
  page: z.number().int().min(1).optional().describe('Page number for pagination (default: 1)'),
  perPage: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Number of repositories per page (default: 30, max: 100)'),
  sort: z
    .enum(['created', 'updated', 'pushed', 'full_name'])
    .optional()
    .describe('Sort order for repositories (default: updated)'),
  org: z.string().optional().describe('Filter by organization name'),
});

/**
 * Input schema for clone_and_setup_repo tool
 */
const CloneAndSetupRepoInputSchema = z.object({
  userId: z.string().uuid().describe('User ID for authentication'),
  repoUrl: z
    .string()
    .url()
    .describe('GitHub repository URL (e.g., https://github.com/owner/repo)'),
  localPath: z
    .string()
    .optional()
    .describe('Optional local path for the repository (auto-generated if not provided)'),
  taskDescription: z
    .string()
    .optional()
    .describe('Optional description of the task/feature you will be working on'),
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
 * Parse GitHub URL to extract owner and repo name
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  try {
    // Handle both https://github.com/owner/repo and https://github.com/owner/repo.git
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') {
      return null;
    }

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) {
      return null;
    }

    const owner = pathParts[0]!;
    let repo = pathParts[1]!;

    // Remove .git suffix if present
    if (repo.endsWith('.git')) {
      repo = repo.slice(0, -4);
    }

    return { owner, repo };
  } catch {
    return null;
  }
}

/**
 * Generate default local path for a repository
 */
function getDefaultLocalPath(owner: string, repo: string): string {
  return generateLocalPath(owner, repo);
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register all Repository management tools with the MCP server
 *
 * @param server - The MCP server instance
 */
export function registerRepositoryTools(server: McpServer): void {
  logger.info('Registering Repository management tools');

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 1: list_repositories
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'list_repositories',
    'List accessible GitHub repositories for the authenticated user. Shows repositories you can push to, sorted by most recently updated.',
    ListRepositoriesInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { userId, page = 1, perPage = 30, sort = 'updated', org } = args as z.infer<
        typeof ListRepositoriesInputSchema
      >;

      logger.info({ userId, page, perPage, sort, org }, 'list_repositories tool called');

      try {
        // Get user and verify authentication
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

        // Get access token
        const accessToken = await authService.getAccessToken(userId);
        if (!accessToken) {
          return successResponse(
            [
              '⚠️ **Session Expired**',
              '',
              'Your GitHub session has expired. Please re-authenticate.',
              '',
              '_Use `authenticate_github` to reconnect your account._',
            ].join('\n')
          );
        }

        // Create GitHub API service
        const githubService = new GitHubAPIService(accessToken);

        // Fetch repositories
        let repositories;
        if (org) {
          repositories = await githubService.listOrganizationRepositories(org, {
            page,
            perPage,
            sort,
          });
        } else {
          repositories = await githubService.listRepositories({
            page,
            perPage,
            sort,
            affiliation: 'owner,collaborator,organization_member',
          });
        }

        // Apply tier-based limit for free users (show max 5 repos for visibility)
        const tierLimits = TIER_LIMITS[user.tier];
        const repoLimit = tierLimits.maxRepos;
        const isLimited = repoLimit !== Infinity && repositories.length > repoLimit;
        const displayRepos = isLimited ? repositories.slice(0, 5) : repositories;

        // Build response
        const lines = ['📚 **Your Repositories**', ''];

        if (org) {
          lines.push(`_Showing repositories from **${org}** organization_`);
          lines.push('');
        }

        if (displayRepos.length === 0) {
          lines.push('No repositories found.');
          lines.push('');
          if (org) {
            lines.push(`Make sure you have access to repositories in the **${org}** organization.`);
          } else {
            lines.push('You may need to create a repository on GitHub first.');
          }
        } else {
          // Display repositories
          for (const repo of displayRepos) {
            const visibility = repo.private ? '🔒' : '🌐';
            const permission =
              repo.permission === 'admin' ? '👑' : repo.permission === 'push' ? '✏️' : '👁️';

            lines.push(`${visibility} **${repo.fullName}** ${permission}`);

            if (repo.description) {
              lines.push(`   ${repo.description.slice(0, 80)}${repo.description.length > 80 ? '...' : ''}`);
            }

            lines.push(`   ⭐ ${repo.stars} | 🔀 ${repo.forks} | Default: \`${repo.defaultBranch}\``);
            lines.push('');
          }

          // Show pagination info
          lines.push(`_Showing ${displayRepos.length} of ${repositories.length} repositories (page ${page})_`);

          // Show tier limitation message for free users
          if (isLimited) {
            lines.push('');
            lines.push(`⚠️ **Free tier limit:** You can clone up to ${repoLimit} repository.`);
            lines.push('_Upgrade to Pro for unlimited repositories._');
          }
        }

        lines.push('');
        lines.push('_Use `clone_and_setup_repo` with a repository URL to start working._');

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, userId }, 'list_repositories failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 2: clone_and_setup_repo
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'clone_and_setup_repo',
    'Clone a GitHub repository to your local machine and set up a work session. Creates database records and prepares the repository for editing.',
    CloneAndSetupRepoInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { userId, repoUrl, localPath, taskDescription } = args as z.infer<
        typeof CloneAndSetupRepoInputSchema
      >;

      logger.info({ userId, repoUrl }, 'clone_and_setup_repo tool called');

      try {
        // Parse GitHub URL
        const parsed = parseGitHubUrl(repoUrl);
        if (!parsed) {
          return successResponse(
            [
              '❌ **Invalid Repository URL**',
              '',
              'The provided URL is not a valid GitHub repository URL.',
              '',
              '**Expected format:**',
              '- `https://github.com/owner/repo`',
              '- `https://github.com/owner/repo.git`',
              '',
              `**Provided:** ${repoUrl}`,
            ].join('\n')
          );
        }

        const { owner, repo } = parsed;

        // Get user and verify authentication
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

        // Get access token
        const accessToken = await authService.getAccessToken(userId);
        if (!accessToken) {
          return successResponse(
            [
              '⚠️ **Session Expired**',
              '',
              'Your GitHub session has expired. Please re-authenticate.',
              '',
              '_Use `authenticate_github` to reconnect your account._',
            ].join('\n')
          );
        }

        // Check tier limits for repository count
        const tierLimits = TIER_LIMITS[user.tier];
        const currentRepoCount = await repositoryRepository.countByUser(userId, true);

        if (tierLimits.maxRepos !== Infinity && currentRepoCount >= tierLimits.maxRepos) {
          return successResponse(
            [
              '🚫 **Repository Limit Reached**',
              '',
              `You have reached your ${user.tier} tier limit of ${tierLimits.maxRepos} cloned repository.`,
              '',
              `**Current cloned repos:** ${currentRepoCount}`,
              '',
              'To clone a new repository, you can either:',
              '- Remove an existing cloned repository',
              '- Upgrade to Pro for unlimited repositories',
              '',
              '_Visit https://gitflowforpms.com/upgrade for more info._',
            ].join('\n')
          );
        }

        // Get repository details from GitHub API
        const githubService = new GitHubAPIService(accessToken);
        const repoDetails = await githubService.getRepoDetails(owner, repo);

        // Check push permission
        if (repoDetails.permission !== 'admin' && repoDetails.permission !== 'push') {
          return successResponse(
            [
              '🚫 **Permission Denied**',
              '',
              `You don't have push access to **${repoDetails.fullName}**.`,
              '',
              `Your permission level: **${repoDetails.permission}** (read-only)`,
              '',
              'To work on this repository, you need:',
              '- **push** access (collaborator), or',
              '- **admin** access (owner/maintainer)',
              '',
              '_Ask the repository owner to grant you access, or fork the repository._',
            ].join('\n')
          );
        }

        // Determine local path
        const finalLocalPath = localPath ?? getDefaultLocalPath(owner, repo);

        // Check if already cloned in our database
        const existingRepo = await repositoryRepository.findByUserAndGitHubRepoId(
          userId,
          repoDetails.id
        );

        if (existingRepo && existingRepo.isCloned) {
          // Repository already exists - resume session
          const existingSession = await sessionRepository.findActiveByUserAndRepo(
            userId,
            existingRepo.id
          );

          if (existingSession) {
            // Update last accessed
            await repositoryRepository.updateLastAccessed(existingRepo.id);

            return successResponse(
              [
                '📁 **Repository Already Cloned**',
                '',
                `**Repository:** ${repoDetails.fullName}`,
                `**Location:** \`${existingRepo.localPath}\``,
                `**Branch:** \`${existingSession.currentBranch}\``,
                '',
                'Your previous session is still active.',
                '',
                existingSession.taskDescription
                  ? `**Current task:** ${existingSession.taskDescription}`
                  : '',
                '',
                '_Use `git_status` to see your current changes._',
              ]
                .filter(Boolean)
                .join('\n')
            );
          }

          // Create new session for existing repo
          await sessionRepository.create({
            userId,
            repoId: existingRepo.id,
            taskDescription: taskDescription ?? null,
            currentBranch: existingRepo.currentBranch,
          });

          await repositoryRepository.updateLastAccessed(existingRepo.id);

          return successResponse(
            [
              '📁 **Repository Already Cloned**',
              '',
              `**Repository:** ${repoDetails.fullName}`,
              `**Location:** \`${existingRepo.localPath}\``,
              `**Branch:** \`${existingRepo.currentBranch}\``,
              '',
              '✅ New session started!',
              '',
              taskDescription ? `**Task:** ${taskDescription}` : '',
              '',
              '_Use `git_pull` to get the latest changes, then start editing._',
            ]
              .filter(Boolean)
              .join('\n')
          );
        }

        // Clone the repository
        logger.info({ owner, repo, localPath: finalLocalPath }, 'Cloning repository');

        const gitService = new GitService({
          userId,
          localPath: finalLocalPath,
          remoteUrl: repoDetails.cloneUrl,
        });

        // Check if already cloned locally (outside our database)
        if (gitService.isCloned()) {
          logger.info({ localPath: finalLocalPath }, 'Repository already exists locally');
        } else {
          // Perform the clone
          await gitService.clone(repoDetails.cloneUrl);
        }

        // Get current branch
        const currentBranch = await gitService.getCurrentBranch();

        // Create or update repository record
        const { repository, created: repoCreated } = await repositoryRepository.findOrCreate({
          userId,
          githubRepoId: repoDetails.id,
          githubOrg: owner,
          githubName: repo,
          githubUrl: repoDetails.url,
          githubDescription: repoDetails.description,
          localPath: finalLocalPath,
        });

        // Mark as cloned
        await repositoryRepository.markAsCloned(repository.id, currentBranch);

        // Create new session
        const session = await sessionRepository.create({
          userId,
          repoId: repository.id,
          taskDescription: taskDescription ?? null,
          currentBranch,
        });

        // Update user's repos accessed count
        if (repoCreated) {
          await userRepository.incrementUsage(userId, 'repos_accessed_count', 1);
        }

        logger.info(
          { userId, repoId: repository.id, sessionId: session.id, localPath: finalLocalPath },
          'Repository cloned and session created'
        );

        // TODO: Start FileWatcherService for this repository
        // fileWatcherService.startWatching(finalLocalPath, userId, repository.id);

        // Build success response
        const lines = [
          '✅ **Repository Cloned Successfully**',
          '',
          `**Repository:** ${repoDetails.fullName}`,
          `**Location:** \`${finalLocalPath}\``,
          `**Branch:** \`${currentBranch}\``,
          repoDetails.private ? '**Visibility:** 🔒 Private' : '**Visibility:** 🌐 Public',
          '',
        ];

        if (taskDescription) {
          lines.push(`**Task:** ${taskDescription}`);
          lines.push('');
        }

        lines.push('**Next Steps:**');
        lines.push('1. Open the repository folder in your editor');
        lines.push('2. Make your changes');
        lines.push('3. Use `git_status` to see what changed');
        lines.push('4. Use `git_commit` to save your work');
        lines.push('5. Use `git_push` to publish to GitHub');
        lines.push('');
        lines.push('_Happy coding! 🚀_');

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, userId, repoUrl }, 'clone_and_setup_repo failed');
        return errorResponse(error);
      }
    }
  );

  logger.info('Repository management tools registered successfully');
}
