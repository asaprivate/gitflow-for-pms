/**
 * Session Management MCP Tools
 *
 * This module provides MCP tools for session management:
 * - list_sessions: List user's past work sessions
 * - get_active_session: Get the current active session
 * - resume_session: Resume a previous session (switch context)
 *
 * These tools allow the AI to query and switch user work contexts,
 * automatically handling branch checkout when resuming sessions.
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { sessionService } from '../../services/SessionService.js';
import { SessionStatus, type ISession } from '../../types/index.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger({ module: 'SessionTools' });

// ============================================================================
// Input Schemas
// ============================================================================

/**
 * Input schema for list_sessions tool
 */
const ListSessionsInputSchema = z.object({
  userId: z.string().uuid().describe('User ID to list sessions for'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum number of sessions to return (default: 5)'),
});

/**
 * Input schema for get_active_session tool
 */
const GetActiveSessionInputSchema = z.object({
  userId: z.string().uuid().describe('User ID to get active session for'),
});

/**
 * Input schema for resume_session tool
 */
const ResumeSessionInputSchema = z.object({
  sessionId: z.string().uuid().describe('Session ID to resume'),
  userId: z.string().uuid().describe('User ID for authorization'),
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
 * Create an error tool response
 */
function errorResponse(
  error: unknown
): { content: Array<{ type: 'text'; text: string }> } {
  const message = error instanceof Error ? error.message : String(error);

  return {
    content: [
      {
        type: 'text',
        text: `❌ **Error**\n\n${message}`,
      },
    ],
  };
}

/**
 * Get status icon for a session
 */
function getStatusIcon(status: SessionStatus): string {
  switch (status) {
    case SessionStatus.ACTIVE:
      return '🟢';
    case SessionStatus.COMPLETED:
      return '✅';
    case SessionStatus.ABANDONED:
      return '🟡';
    default:
      return '⚫';
  }
}

/**
 * Format a session for display
 */
function formatSession(session: ISession, detailed: boolean = false): string {
  const stats = sessionService.getSessionStats(session);
  const icon = getStatusIcon(session.status);

  const lines: string[] = [];

  if (detailed) {
    lines.push(`${icon} **${session.taskDescription ?? 'Untitled Task'}**`);
    lines.push(`   • Session ID: \`${session.id.substring(0, 8)}...\``);
    lines.push(`   • Branch: \`${session.currentBranch}\``);
    lines.push(`   • Status: ${session.status}`);
    lines.push(`   • Duration: ${stats.durationFormatted}`);
    lines.push(`   • Commits: ${session.commitsInSession}`);

    if (session.prNumber) {
      lines.push(`   • PR: #${session.prNumber}`);
    }
  } else {
    const task = session.taskDescription ?? 'Untitled Task';
    const truncatedTask = task.length > 40 ? task.substring(0, 37) + '...' : task;
    lines.push(
      `${icon} ${truncatedTask} | \`${session.currentBranch}\` | ${stats.durationFormatted}`
    );
  }

  return lines.join('\n');
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register all Session management tools with the MCP server
 *
 * @param server - The MCP server instance
 */
export function registerSessionTools(server: McpServer): void {
  logger.info('Registering Session management tools');

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 1: list_sessions
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'list_sessions',
    'List past work sessions for a user. Shows session history with task names, branches, and status. Useful for finding sessions to resume.',
    ListSessionsInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { userId, limit } = args as z.infer<typeof ListSessionsInputSchema>;
      const effectiveLimit = limit ?? 5;

      logger.info({ userId, limit: effectiveLimit }, 'list_sessions tool called');

      try {
        const sessions = await sessionService.getSessionHistory(userId, effectiveLimit);

        if (sessions.length === 0) {
          return successResponse(
            [
              '📋 **Your Sessions**',
              '',
              '_No sessions found. Start working on a repository to create your first session._',
            ].join('\n')
          );
        }

        const lines = [
          '📋 **Your Sessions**',
          '',
          '**Legend:** 🟢 Active | ✅ Completed | 🟡 Abandoned',
          '',
        ];

        for (const session of sessions) {
          lines.push(formatSession(session, false));
        }

        lines.push('');
        lines.push(`_Showing ${sessions.length} session(s)._`);
        lines.push('');
        lines.push('_Use `resume_session` with a session ID to switch back to a previous task._');

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, userId }, 'list_sessions failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 2: get_active_session
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'get_active_session',
    'Get the currently active work session for a user. Shows what task they are working on and which branch they are on.',
    GetActiveSessionInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { userId } = args as z.infer<typeof GetActiveSessionInputSchema>;

      logger.info({ userId }, 'get_active_session tool called');

      try {
        const session = await sessionService.getCurrentSession(userId);

        if (!session) {
          return successResponse(
            [
              '📍 **Current Session**',
              '',
              '_No active session._',
              '',
              'You are not currently working on any task.',
              '',
              '**Next Steps:**',
              '- Use `clone_and_setup_repo` to start working on a repository',
              '- Use `resume_session` to continue a previous task',
            ].join('\n')
          );
        }

        const stats = sessionService.getSessionStats(session);

        const lines = [
          '📍 **Current Session**',
          '',
          formatSession(session, true),
          '',
          '**Time in session:** ' + stats.durationFormatted,
        ];

        if (session.prNumber) {
          lines.push(`**Pull Request:** #${session.prNumber}`);
          if (session.prUrl) {
            lines.push(`**PR URL:** ${session.prUrl}`);
          }
        }

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, userId }, 'get_active_session failed');
        return errorResponse(error);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool 3: resume_session
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    'resume_session',
    'Resume a previous work session. This switches your context back to a previous task, automatically checking out the correct Git branch. Any currently active session will be paused.',
    ResumeSessionInputSchema.shape,
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const { sessionId, userId } = args as z.infer<typeof ResumeSessionInputSchema>;

      logger.info({ sessionId, userId }, 'resume_session tool called');

      try {
        const result = await sessionService.resumeSession(sessionId, userId);
        const { session, branchCheckedOut, reopened } = result;

        const lines = ['🔄 **Context Switched**', ''];

        // Friendly message about what happened
        if (reopened) {
          lines.push(
            `✨ **Resumed task:** ${session.taskDescription ?? 'Untitled Task'}`
          );
        } else {
          lines.push(
            `✨ **Continued task:** ${session.taskDescription ?? 'Untitled Task'}`
          );
        }

        lines.push('');
        lines.push(`**Branch:** \`${session.currentBranch}\``);

        if (branchCheckedOut) {
          lines.push('');
          lines.push(`✅ Git branch automatically switched to \`${session.currentBranch}\``);
        } else {
          lines.push('');
          lines.push(
            `⚠️ Could not automatically switch branches. You may need to checkout \`${session.currentBranch}\` manually.`
          );
        }

        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(`_You are now working on: "${session.taskDescription ?? 'Untitled Task'}"_`);
        lines.push('');
        lines.push('**Ready to continue!** Your previous work session has been restored.');

        return successResponse(lines.join('\n'));
      } catch (error) {
        logger.error({ error, sessionId, userId }, 'resume_session failed');

        // Provide helpful error messages
        const errorMessage = error instanceof Error ? error.message : String(error);

        let helpMessage = '';
        if (errorMessage.includes('not found')) {
          helpMessage =
            '\n\n_Use `list_sessions` to see your available sessions._';
        } else if (errorMessage.includes('permission')) {
          helpMessage =
            '\n\n_You can only resume your own sessions._';
        } else if (errorMessage.includes('not cloned')) {
          helpMessage =
            '\n\n_The repository needs to be cloned locally first. Use `clone_and_setup_repo` to clone it._';
        }

        return {
          content: [
            {
              type: 'text',
              text: `❌ **Error Resuming Session**\n\n${errorMessage}${helpMessage}`,
            },
          ],
        };
      }
    }
  );

  logger.info('Session management tools registered successfully');
}
