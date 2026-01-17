/**
 * MCP Protocol Layer
 *
 * This module sets up the Model Context Protocol (MCP) server
 * and registers all available tools for AI IDE integration.
 *
 * The MCP server exposes tools organized in categories:
 *
 * **Authentication Tools:**
 * - authenticate_github - GitHub OAuth authentication
 * - check_auth_status - Check if user is authenticated
 * - logout - Logout and revoke tokens
 *
 * **Repository Tools (to be implemented):**
 * - list_repositories - List accessible repositories
 * - clone_and_setup_repo - Clone a repository locally
 * - get_repo_status - Get current repository status
 *
 * **Git Workflow Tools (to be implemented):**
 * - save_changes - Commit changes to a branch
 * - push_for_review - Push and create a pull request
 * - pull_latest - Pull latest changes from remote
 * - sync_with_main - Check sync status with main branch
 * - start_new_task - Create a new feature branch
 * - merge_pr - Merge a pull request
 * - cleanup_and_reset - Clean up old branches
 * - undo_last_commit - Soft reset the last commit
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createChildLogger } from '../utils/logger.js';
import { registerAllTools } from './tools/index.js';

const logger = createChildLogger({ module: 'MCPServer' });

/**
 * MCP Server configuration options
 */
export interface IMCPServerOptions {
  readonly name: string;
  readonly version: string;
}

/**
 * Create and configure the MCP server instance
 *
 * This function:
 * 1. Creates a new McpServer with the provided options
 * 2. Registers all available tools (auth, repo, workflow)
 * 3. Sets up error handling
 *
 * @param options - Server configuration options
 * @returns Configured McpServer instance
 */
export function createMCPServer(options: IMCPServerOptions): McpServer {
  const { name, version } = options;

  logger.info({ name, version }, 'Creating MCP server');

  const server = new McpServer(
    {
      name,
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register error handler on the underlying server
  server.server.onerror = (error): void => {
    logger.error({ error }, 'MCP server error');
  };

  // Register all MCP tools with the server
  logger.info('Registering MCP tools');
  registerAllTools(server);

  return server;
}

/**
 * Start the MCP server with stdio transport
 *
 * The server uses stdio transport for communication with AI IDEs.
 * All logs go to stderr to avoid interfering with MCP protocol on stdout.
 *
 * @param server - The MCP server instance to start
 */
export async function startMCPServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();

  logger.info('Starting MCP server with stdio transport');

  await server.connect(transport);

  // Log to stderr (NOT stdout) because stdout is reserved for MCP protocol
  console.error('GitFlow MCP Server running...');

  logger.info('MCP server connected and ready');
}

/**
 * Gracefully shutdown the MCP server
 *
 * @param server - The MCP server instance to shutdown
 */
export async function shutdownMCPServer(server: McpServer): Promise<void> {
  logger.info('Shutting down MCP server');

  await server.close();

  logger.info('MCP server shutdown complete');
}
