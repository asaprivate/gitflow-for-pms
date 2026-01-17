/**
 * Database Module
 *
 * Re-exports database client and utilities.
 * This module provides the public interface for database operations.
 */

// Re-export QueryResultRow for type constraints
export type { QueryResultRow } from 'pg';

export {
  // Connection management
  getPool,
  initializeDatabase,
  closePool,
  checkConnection,
  getPoolStats,

  // Query execution
  query,
  queryOne,
  queryMany,
  transaction,

  // Types
  type IDatabasePoolConfig,
  type IQueryResult,
  type ITransactionClient,
} from './client.js';
