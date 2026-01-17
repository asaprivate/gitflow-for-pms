/**
 * PostgreSQL Database Client
 *
 * Provides connection pooling and query execution for the GitFlow MCP Server.
 * Uses the 'pg' library with proper error handling and connection management.
 */

import pg, { type QueryResultRow } from 'pg';

import { createChildLogger } from '../utils/logger.js';

const { Pool } = pg;

/**
 * Database logger instance
 */
const dbLogger = createChildLogger({ module: 'database' });

/**
 * Database pool configuration interface
 */
export interface IDatabasePoolConfig {
  readonly connectionString: string;
  readonly min: number;
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
  readonly allowExitOnIdle: boolean;
}

/**
 * Query result type
 */
export interface IQueryResult<T extends QueryResultRow> {
  readonly rows: T[];
  readonly rowCount: number | null;
  readonly command: string;
}

/**
 * Transaction client interface
 */
export interface ITransactionClient {
  query<T extends QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<IQueryResult<T>>;
  release(): void;
}

/**
 * Default pool configuration
 */
function getDefaultPoolConfig(): IDatabasePoolConfig {
  const databaseUrl = process.env['DATABASE_URL'];

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    connectionString: databaseUrl,
    min: parseInt(process.env['DB_POOL_MIN'] ?? '2', 10),
    max: parseInt(process.env['DB_POOL_MAX'] ?? '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: process.env['NODE_ENV'] === 'test',
  };
}

/**
 * Database connection pool singleton
 */
let pool: pg.Pool | null = null;

/**
 * Get or create the database connection pool
 */
export function getPool(): pg.Pool {
  if (pool === null) {
    const config = getDefaultPoolConfig();

    dbLogger.info(
      {
        min: config.min,
        max: config.max,
        idleTimeout: config.idleTimeoutMillis,
      },
      'Creating database connection pool'
    );

    pool = new Pool({
      connectionString: config.connectionString,
      min: config.min,
      max: config.max,
      idleTimeoutMillis: config.idleTimeoutMillis,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      allowExitOnIdle: config.allowExitOnIdle,
    });

    // Pool event handlers
    pool.on('connect', () => {
      dbLogger.debug('New client connected to pool');
    });

    pool.on('acquire', () => {
      dbLogger.trace('Client acquired from pool');
    });

    pool.on('release', () => {
      dbLogger.trace('Client released back to pool');
    });

    pool.on('error', (err: Error) => {
      dbLogger.error({ error: err }, 'Unexpected pool error');
    });

    pool.on('remove', () => {
      dbLogger.debug('Client removed from pool');
    });
  }

  return pool;
}

/**
 * Execute a SQL query with parameters
 *
 * @param text - SQL query string with $1, $2, etc. placeholders
 * @param values - Parameter values for placeholders
 * @returns Query result with rows and metadata
 *
 * @example
 * ```ts
 * const result = await query<IUser>(
 *   'SELECT * FROM users WHERE github_id = $1',
 *   [12345]
 * );
 * const user = result.rows[0];
 * ```
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[]
): Promise<IQueryResult<T>> {
  const start = Date.now();
  const dbPool = getPool();

  try {
    const result = await dbPool.query<T>(text, values);
    const duration = Date.now() - start;

    dbLogger.debug(
      {
        query: text.substring(0, 100),
        duration,
        rowCount: result.rowCount,
      },
      'Query executed'
    );

    // Warn on slow queries (>100ms)
    if (duration > 100) {
      dbLogger.warn(
        {
          query: text,
          duration,
          rowCount: result.rowCount,
        },
        'Slow query detected'
      );
    }

    return {
      rows: result.rows,
      rowCount: result.rowCount,
      command: result.command,
    };
  } catch (error) {
    const duration = Date.now() - start;

    dbLogger.error(
      {
        query: text,
        duration,
        error,
      },
      'Query failed'
    );

    throw error;
  }
}

/**
 * Execute a query and return the first row or null
 */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[]
): Promise<T | null> {
  const result = await query<T>(text, values);
  return result.rows[0] ?? null;
}

/**
 * Execute a query and return all rows
 */
export async function queryMany<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[]
): Promise<T[]> {
  const result = await query<T>(text, values);
  return result.rows;
}

/**
 * Execute a transaction with automatic commit/rollback
 *
 * @param fn - Async function that receives a transaction client
 * @returns Result of the transaction function
 *
 * @example
 * ```ts
 * const user = await transaction(async (client) => {
 *   const userResult = await client.query<IUserRow>(
 *     'INSERT INTO users (...) VALUES (...) RETURNING *',
 *     [...]
 *   );
 *   await client.query(
 *     'INSERT INTO sessions (...) VALUES (...)',
 *     [userResult.rows[0].id, ...]
 *   );
 *   return userResult.rows[0];
 * });
 * ```
 */
export async function transaction<T>(
  fn: (client: ITransactionClient) => Promise<T>
): Promise<T> {
  const dbPool = getPool();
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');
    dbLogger.debug('Transaction started');

    const result = await fn({
      query: async <R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[]
      ): Promise<IQueryResult<R>> => {
        const queryResult = await client.query<R>(text, values);
        return {
          rows: queryResult.rows,
          rowCount: queryResult.rowCount,
          command: queryResult.command,
        };
      },
      release: () => client.release(),
    });

    await client.query('COMMIT');
    dbLogger.debug('Transaction committed');

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    dbLogger.error({ error }, 'Transaction rolled back');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Check database connectivity
 */
export async function checkConnection(): Promise<boolean> {
  try {
    const result = await query<{ now: Date }>('SELECT NOW() as now');
    dbLogger.info({ serverTime: result.rows[0]?.now }, 'Database connection verified');
    return true;
  } catch (error) {
    dbLogger.error({ error }, 'Database connection check failed');
    return false;
  }
}

/**
 * Get pool statistics for monitoring
 */
export function getPoolStats(): {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
} {
  const dbPool = getPool();
  return {
    totalCount: dbPool.totalCount,
    idleCount: dbPool.idleCount,
    waitingCount: dbPool.waitingCount,
  };
}

/**
 * Close all database connections
 * Call during application shutdown
 */
export async function closePool(): Promise<void> {
  if (pool !== null) {
    dbLogger.info('Closing database connection pool');
    await pool.end();
    pool = null;
    dbLogger.info('Database connection pool closed');
  }
}

/**
 * Initialize database connection and verify connectivity
 */
export async function initializeDatabase(): Promise<void> {
  dbLogger.info('Initializing database connection...');

  const connected = await checkConnection();

  if (!connected) {
    throw new Error('Failed to connect to database');
  }

  dbLogger.info('Database initialized successfully');
}
