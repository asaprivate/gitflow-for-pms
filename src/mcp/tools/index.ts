/**
 * MCP Tools Registry
 *
 * This module exports all MCP tools and provides registration utilities.
 * Each tool follows the MCP protocol specification with:
 * - name: Unique tool identifier
 * - description: Human-readable description for the AI
 * - inputSchema: JSON Schema for tool parameters
 * - execute: Async function that performs the tool action
 *
 * Tools are registered directly with the McpServer using its `tool()` method.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createChildLogger } from '../../utils/logger.js';
import { registerAuthTools } from './authTools.js';
import { registerGitTools } from './gitTools.js';
import { registerRepositoryTools } from './repositoryTools.js';
import { registerGitOperationTools } from './gitOperationTools.js';
import { registerSessionTools } from './sessionTools.js';

const logger = createChildLogger({ module: 'ToolsRegistry' });

/**
 * Tool names enum for type safety
 */
export enum ToolName {
  // Authentication Tools
  AUTHENTICATE_GITHUB = 'authenticate_github',
  CHECK_AUTH_STATUS = 'check_auth_status',
  LOGOUT = 'logout',
  // Git Operation Tools (low-level)
  GIT_STATUS = 'git_status',
  GIT_COMMIT = 'git_commit',
  GIT_PUSH = 'git_push',
  GIT_PULL = 'git_pull',
  GIT_CLONE = 'git_clone',
  GIT_CHECKOUT = 'git_checkout',
  // Repository Tools
  LIST_REPOSITORIES = 'list_repositories',
  CLONE_AND_SETUP_REPO = 'clone_and_setup_repo',
  // Smart Git Operation Tools (PM-friendly)
  GET_REPO_STATUS = 'get_repo_status',
  SAVE_CHANGES = 'save_changes',
  PUSH_FOR_REVIEW = 'push_for_review',
  // Session Management Tools
  LIST_SESSIONS = 'list_sessions',
  GET_ACTIVE_SESSION = 'get_active_session',
  RESUME_SESSION = 'resume_session',
  // Git Workflow Tools (to be implemented)
  PULL_LATEST = 'pull_latest',
  SYNC_WITH_MAIN = 'sync_with_main',
  START_NEW_TASK = 'start_new_task',
  MERGE_PR = 'merge_pr',
  CLEANUP_AND_RESET = 'cleanup_and_reset',
  UNDO_LAST_COMMIT = 'undo_last_commit',
}

/**
 * Register all tools with the MCP server
 *
 * This function registers all implemented tools with the server.
 * Tools are grouped by category:
 * - Authentication: authenticate_github, check_auth_status, logout
 * - Git Operations (low-level): git_status, git_commit, git_push, git_pull, git_clone, git_checkout
 * - Repository: list_repositories, clone_and_setup_repo
 * - Smart Git Operations (PM-friendly): get_repo_status, save_changes, push_for_review
 * - Session Management: list_sessions, get_active_session, resume_session
 * - Workflow: pull_latest, sync_with_main, start_new_task, merge_pr,
 *            cleanup_and_reset, undo_last_commit (to be implemented)
 *
 * @param server - The MCP server instance
 */
export function registerAllTools(server: McpServer): void {
  logger.info('Registering all MCP tools');

  // Register Authentication Tools (3 tools)
  registerAuthTools(server);

  // Register Git Operation Tools - low-level (6 tools)
  registerGitTools(server);

  // Register Repository Tools (2 tools)
  registerRepositoryTools(server);

  // Register Smart Git Operation Tools - PM-friendly (3 tools)
  registerGitOperationTools(server);

  // Register Session Management Tools (3 tools)
  registerSessionTools(server);

  // Register Workflow Tools (to be implemented)
  // registerWorkflowTools(server);

  logger.info('All MCP tools registered successfully');
}

// Re-export tool registration functions for individual use
export { registerAuthTools } from './authTools.js';
export { registerGitTools } from './gitTools.js';
export { registerRepositoryTools } from './repositoryTools.js';
export { registerGitOperationTools } from './gitOperationTools.js';
export { registerSessionTools } from './sessionTools.js';
