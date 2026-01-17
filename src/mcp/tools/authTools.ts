/**
 * Authentication MCP Tools
 *
 * This module provides MCP tools for GitHub authentication:
 * - authenticate_github: Initiate GitHub OAuth flow
 * - check_auth_status: Check if user is authenticated
 * - logout: Logout and revoke tokens
 *
 * These tools wrap the AuthService methods and provide user-friendly
 * responses suitable for AI IDE interaction.
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { authService } from '../../services/AuthService.js';
import { userRepository } from '../../repositories/UserRepository.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger({ module: 'AuthTools' });

/**
 * Input schema for authenticate_github tool
 * No parameters required - initiates OAuth flow
 */
const AuthenticateGitHubInputSchema = z.object({});

/**
 * Input schema for check_auth_status tool
 */
const CheckAuthStatusInputSchema = z.object({
  userId: z.string().uuid().describe('The user ID to check authentication status for'),
});

/**
 * Input schema for logout tool
 */
const LogoutInputSchema = z.object({
  userId: z.string().uuid().describe('The user ID to logout'),
});

/**
 * Register all authentication tools with the MCP server
 *
 * @param server - The MCP server instance
 */
export function registerAuthTools(server: McpServer): void {
  logger.info('Registering authentication tools');

  // Tool 1: authenticate_github
  server.tool(
    'authenticate_github',
    'Initiate GitHub OAuth authentication. Returns an authorization URL that the user must visit to grant access. No parameters required.',
    AuthenticateGitHubInputSchema.shape,
    async (_args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      logger.info('authenticate_github tool called');

      try {
        const oauthResponse = authService.initiateOAuth();

        const responseText = [
          '🔐 **GitHub Authentication Required**',
          '',
          'To connect GitFlow to your GitHub account, please:',
          '',
          `1. Click this link: ${oauthResponse.oauthUrl}`,
          '2. Sign in to GitHub if prompted',
          '3. Authorize GitFlow for PMs to access your repositories',
          '4. You will be redirected back after authorization',
          '',
          `⏱️ This link expires in ${Math.floor(oauthResponse.expiresIn / 60)} minutes.`,
          '',
          '_After authorization, use `check_auth_status` to verify your connection._',
        ].join('\n');

        logger.info('OAuth flow initiated successfully');

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      } catch (error) {
        logger.error({ error }, 'Failed to initiate OAuth flow');

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred';

        return {
          content: [
            {
              type: 'text',
              text: [
                '❌ **Authentication Failed**',
                '',
                `Error: ${errorMessage}`,
                '',
                'Suggestions:',
                '- Check your internet connection',
                '- Verify GitHub OAuth app configuration',
                '- Try again in a few moments',
              ].join('\n'),
            },
          ],
        };
      }
    }
  );

  // Tool 2: check_auth_status
  server.tool(
    'check_auth_status',
    'Check if a user is authenticated with GitHub. Returns authentication status and user profile if authenticated.',
    CheckAuthStatusInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { userId } = args as z.infer<typeof CheckAuthStatusInputSchema>;

      logger.info({ userId }, 'check_auth_status tool called');

      try {
        // Find user in database
        const user = await userRepository.findById(userId);

        if (!user) {
          logger.info({ userId }, 'User not found');

          return {
            content: [
              {
                type: 'text',
                text: [
                  '🔒 **Not Authenticated**',
                  '',
                  'Status: `anonymous`',
                  '',
                  'You are not currently authenticated with GitHub.',
                  'Use `authenticate_github` to connect your GitHub account.',
                ].join('\n'),
              },
            ],
          };
        }

        // Try to get access token to verify it's still valid
        const accessToken = await authService.getAccessToken(userId);
        const hasValidToken = accessToken !== null;

        if (!hasValidToken) {
          logger.info({ userId }, 'User exists but no valid token');

          return {
            content: [
              {
                type: 'text',
                text: [
                  '⚠️ **Session Expired**',
                  '',
                  'Status: `session_expired`',
                  '',
                  `User: @${user.githubUsername}`,
                  '',
                  'Your GitHub session has expired.',
                  'Use `authenticate_github` to reconnect your account.',
                ].join('\n'),
              },
            ],
          };
        }

        logger.info({ userId, username: user.githubUsername }, 'User is authenticated');

        return {
          content: [
            {
              type: 'text',
              text: [
                '✅ **Authenticated**',
                '',
                'Status: `authenticated`',
                '',
                `**GitHub Account:** @${user.githubUsername}`,
                `**Email:** ${user.email}`,
                `**Tier:** ${user.tier}`,
                user.fullName ? `**Name:** ${user.fullName}` : '',
                '',
                `**Usage This Month:**`,
                `- Commits: ${user.commitsUsedThisMonth}`,
                `- PRs Created: ${user.prsCreatedThisMonth}`,
                '',
                '_You are ready to start using GitFlow!_',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, userId }, 'Failed to check auth status');

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred';

        return {
          content: [
            {
              type: 'text',
              text: [
                '❌ **Error Checking Status**',
                '',
                `Error: ${errorMessage}`,
                '',
                'Suggestions:',
                '- Check your internet connection',
                '- Try again in a few moments',
                '- Use `authenticate_github` to re-authenticate',
              ].join('\n'),
            },
          ],
        };
      }
    }
  );

  // Tool 3: logout
  server.tool(
    'logout',
    'Logout from GitHub and revoke stored tokens. This will disconnect your GitHub account from GitFlow.',
    LogoutInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { userId } = args as z.infer<typeof LogoutInputSchema>;

      logger.info({ userId }, 'logout tool called');

      try {
        // Verify user exists first
        const user = await userRepository.findById(userId);

        if (!user) {
          logger.warn({ userId }, 'Logout attempted for non-existent user');

          return {
            content: [
              {
                type: 'text',
                text: [
                  '⚠️ **User Not Found**',
                  '',
                  'No user found with that ID.',
                  'You may already be logged out.',
                ].join('\n'),
              },
            ],
          };
        }

        // Perform logout
        await authService.logout(userId);

        logger.info({ userId, username: user.githubUsername }, 'User logged out successfully');

        return {
          content: [
            {
              type: 'text',
              text: [
                '👋 **Logged Out Successfully**',
                '',
                `Goodbye, @${user.githubUsername}!`,
                '',
                'Your GitHub tokens have been removed from:',
                '- System keychain (secure storage)',
                '- Local session data',
                '',
                'To use GitFlow again, use `authenticate_github` to reconnect.',
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, userId }, 'Failed to logout');

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred';

        return {
          content: [
            {
              type: 'text',
              text: [
                '❌ **Logout Failed**',
                '',
                `Error: ${errorMessage}`,
                '',
                'Your local tokens may not have been fully cleared.',
                'Try again or contact support if the issue persists.',
              ].join('\n'),
            },
          ],
        };
      }
    }
  );

  logger.info('Authentication tools registered successfully');
}
