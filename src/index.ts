/**
 * GitFlow MCP Server - Entry Point
 *
 * This is the main entry point for the GitFlow for PMs MCP server.
 * It initializes all services, sets up the MCP server, and handles
 * graceful shutdown.
 *
 * @module GitFlow MCP Server
 * @version 0.1.0
 */

import 'dotenv/config';

import { createMCPServer, startMCPServer, shutdownMCPServer } from './mcp/index.js';
import { initializeDatabase, closePool } from './db/index.js';
import { logger, createChildLogger } from './utils/logger.js';
import { getConfig } from './config/index.js';

/**
 * Application metadata
 */
const APP_NAME = 'gitflow-mcp-server';
const APP_VERSION = '0.1.0';

/**
 * Create a logger for the main module
 */
const mainLogger = createChildLogger({ module: 'main' });

/**
 * Graceful shutdown handler
 */
async function handleShutdown(signal: string, server: ReturnType<typeof createMCPServer>): Promise<void> {
  mainLogger.info({ signal }, 'Received shutdown signal');

  try {
    // Shutdown MCP server
    await shutdownMCPServer(server);

    // Close database connection pool
    await closePool();

    mainLogger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    mainLogger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

/**
 * Main application entry point
 */
async function main(): Promise<void> {
  mainLogger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  mainLogger.info(`  GitFlow MCP Server v${APP_VERSION}`);
  mainLogger.info('  Enabling PMs to manage Git workflows through AI IDEs');
  mainLogger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  try {
    // Load and validate configuration
    const config = getConfig();
    mainLogger.info({ env: config.app.env, logLevel: config.app.logLevel }, 'Configuration loaded');

    // Initialize database connection
    mainLogger.info('Initializing database connection...');
    await initializeDatabase();

    // Create MCP server
    mainLogger.info('Creating MCP server...');
    const server = createMCPServer({
      name: APP_NAME,
      version: APP_VERSION,
    });

    // Register shutdown handlers
    process.on('SIGINT', () => {
      void handleShutdown('SIGINT', server);
    });

    process.on('SIGTERM', () => {
      void handleShutdown('SIGTERM', server);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      mainLogger.fatal({ error }, 'Uncaught exception');
      void handleShutdown('uncaughtException', server);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason) => {
      mainLogger.fatal({ reason }, 'Unhandled promise rejection');
      void handleShutdown('unhandledRejection', server);
    });

    // Start MCP server
    mainLogger.info('Starting MCP server...');
    await startMCPServer(server);

    mainLogger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    mainLogger.info('  ✓ GitFlow MCP Server is ready!');
    mainLogger.info('  ✓ Connect your AI IDE to start using GitFlow');
    mainLogger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (error) {
    mainLogger.fatal({ error }, 'Failed to start GitFlow MCP Server');
    process.exit(1);
  }
}

// Start the application
main().catch((error: unknown) => {
  logger.fatal({ error }, 'Unhandled error in main');
  process.exit(1);
});
