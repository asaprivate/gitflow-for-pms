/**
 * Session Repository
 *
 * Data access layer for session operations.
 * Handles CRUD operations for the sessions table that tracks work sessions.
 * A session represents a single task/feature from start to merge.
 */

import { query, queryOne, transaction, type ITransactionClient } from '../db/client.js';
import { type ISession, type ICreateSessionData, SessionStatus } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'SessionRepository' });

/**
 * Database row type for sessions table
 */
interface ISessionRow {
  id: string;
  user_id: string;
  repo_id: string;
  task_description: string | null;
  current_branch: string;
  pr_id: number | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_created_at: Date | null;
  pr_merged_at: Date | null;
  commits_in_session: number;
  last_action: string | null;
  last_action_at: Date | null;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Map database row to ISession interface
 */
function mapRowToSession(row: ISessionRow): ISession {
  return {
    id: row.id,
    userId: row.user_id,
    repoId: row.repo_id,
    taskDescription: row.task_description,
    currentBranch: row.current_branch,
    prId: row.pr_id,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    prCreatedAt: row.pr_created_at,
    prMergedAt: row.pr_merged_at,
    commitsInSession: row.commits_in_session,
    lastAction: row.last_action,
    lastActionAt: row.last_action_at,
    status: row.status as SessionStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Session Repository class for database operations
 */
export class SessionRepository {
  /**
   * Find session by ID
   */
  async findById(id: string): Promise<ISession | null> {
    logger.debug({ sessionId: id }, 'Finding session by ID');

    const row = await queryOne<ISessionRow>(
      `SELECT * FROM sessions WHERE id = $1`,
      [id]
    );

    return row ? mapRowToSession(row) : null;
  }

  /**
   * Find active session for a user
   */
  async findActiveByUserId(userId: string): Promise<ISession | null> {
    logger.debug({ userId }, 'Finding active session for user');

    const row = await queryOne<ISessionRow>(
      `SELECT * FROM sessions WHERE user_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
      [userId]
    );

    return row ? mapRowToSession(row) : null;
  }

  /**
   * Find active session for a repository
   */
  async findActiveByRepoId(repoId: string): Promise<ISession | null> {
    logger.debug({ repoId }, 'Finding active session for repository');

    const row = await queryOne<ISessionRow>(
      `SELECT * FROM sessions WHERE repo_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
      [repoId]
    );

    return row ? mapRowToSession(row) : null;
  }

  /**
   * Find active session for a user and repository
   */
  async findActiveByUserAndRepo(userId: string, repoId: string): Promise<ISession | null> {
    logger.debug({ userId, repoId }, 'Finding active session for user and repository');

    const row = await queryOne<ISessionRow>(
      `SELECT * FROM sessions WHERE user_id = $1 AND repo_id = $2 AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
      [userId, repoId]
    );

    return row ? mapRowToSession(row) : null;
  }

  /**
   * List sessions for a user
   */
  async listByUser(
    userId: string,
    status?: SessionStatus,
    limit: number = 20
  ): Promise<readonly ISession[]> {
    logger.debug({ userId, status, limit }, 'Listing sessions for user');

    let queryText = `SELECT * FROM sessions WHERE user_id = $1`;
    const params: unknown[] = [userId];

    if (status) {
      queryText += ` AND status = $2`;
      params.push(status);
    }

    queryText += ` ORDER BY started_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await query<ISessionRow>(queryText, params);

    return result.rows.map(mapRowToSession);
  }

  /**
   * List sessions for a repository
   */
  async listByRepo(repoId: string, limit: number = 20): Promise<readonly ISession[]> {
    logger.debug({ repoId, limit }, 'Listing sessions for repository');

    const result = await query<ISessionRow>(
      `SELECT * FROM sessions WHERE repo_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [repoId, limit]
    );

    return result.rows.map(mapRowToSession);
  }

  /**
   * Create a new session
   */
  async create(data: ICreateSessionData): Promise<ISession> {
    logger.info(
      { userId: data.userId, repoId: data.repoId, branch: data.currentBranch },
      'Creating session'
    );

    // First, abandon any existing active sessions for this user/repo
    await this.abandonActiveSession(data.userId, data.repoId);

    const result = await query<ISessionRow>(
      `INSERT INTO sessions (
        user_id,
        repo_id,
        task_description,
        current_branch,
        status,
        started_at,
        last_action,
        last_action_at
      ) VALUES ($1, $2, $3, $4, 'active', NOW(), 'session_started', NOW())
      RETURNING *`,
      [
        data.userId,
        data.repoId,
        data.taskDescription,
        data.currentBranch,
      ]
    );

    const session = mapRowToSession(result.rows[0]!);
    logger.info({ sessionId: session.id, branch: session.currentBranch }, 'Session created');

    return session;
  }

  /**
   * Find or create session (ensures only one active session per user/repo)
   */
  async findOrCreate(data: ICreateSessionData): Promise<{ session: ISession; created: boolean }> {
    logger.debug({ userId: data.userId, repoId: data.repoId }, 'Finding or creating session');

    return await transaction(async (client: ITransactionClient) => {
      // Check for existing active session
      const existingResult = await client.query<ISessionRow>(
        `SELECT * FROM sessions 
         WHERE user_id = $1 AND repo_id = $2 AND status = 'active' 
         ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
        [data.userId, data.repoId]
      );

      if (existingResult.rows[0]) {
        // Session exists - update last action
        const updateResult = await client.query<ISessionRow>(
          `UPDATE sessions SET
            last_action = 'session_resumed',
            last_action_at = NOW()
          WHERE id = $1
          RETURNING *`,
          [existingResult.rows[0].id]
        );

        logger.info(
          { sessionId: existingResult.rows[0].id },
          'Existing active session found and resumed'
        );

        return {
          session: mapRowToSession(updateResult.rows[0]!),
          created: false,
        };
      }

      // No active session - create new
      const createResult = await client.query<ISessionRow>(
        `INSERT INTO sessions (
          user_id,
          repo_id,
          task_description,
          current_branch,
          status,
          started_at,
          last_action,
          last_action_at
        ) VALUES ($1, $2, $3, $4, 'active', NOW(), 'session_started', NOW())
        RETURNING *`,
        [data.userId, data.repoId, data.taskDescription, data.currentBranch]
      );

      const session = mapRowToSession(createResult.rows[0]!);
      logger.info({ sessionId: session.id, branch: session.currentBranch }, 'New session created');

      return { session, created: true };
    });
  }

  /**
   * Update session fields
   */
  async update(
    id: string,
    updates: Partial<{
      taskDescription: string | null;
      currentBranch: string;
      prId: number | null;
      prNumber: number | null;
      prUrl: string | null;
      prCreatedAt: Date | null;
      prMergedAt: Date | null;
      lastAction: string;
      status: SessionStatus;
    }>
  ): Promise<ISession | null> {
    logger.debug({ sessionId: id, updates: Object.keys(updates) }, 'Updating session');

    // Build dynamic update query
    const setClauses: string[] = ['last_action_at = NOW()'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.taskDescription !== undefined) {
      setClauses.push(`task_description = $${paramIndex++}`);
      values.push(updates.taskDescription);
    }
    if (updates.currentBranch !== undefined) {
      setClauses.push(`current_branch = $${paramIndex++}`);
      values.push(updates.currentBranch);
    }
    if (updates.prId !== undefined) {
      setClauses.push(`pr_id = $${paramIndex++}`);
      values.push(updates.prId);
    }
    if (updates.prNumber !== undefined) {
      setClauses.push(`pr_number = $${paramIndex++}`);
      values.push(updates.prNumber);
    }
    if (updates.prUrl !== undefined) {
      setClauses.push(`pr_url = $${paramIndex++}`);
      values.push(updates.prUrl);
    }
    if (updates.prCreatedAt !== undefined) {
      setClauses.push(`pr_created_at = $${paramIndex++}`);
      values.push(updates.prCreatedAt);
    }
    if (updates.prMergedAt !== undefined) {
      setClauses.push(`pr_merged_at = $${paramIndex++}`);
      values.push(updates.prMergedAt);
    }
    if (updates.lastAction !== undefined) {
      setClauses.push(`last_action = $${paramIndex++}`);
      values.push(updates.lastAction);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);
      if (updates.status === SessionStatus.COMPLETED || updates.status === SessionStatus.ABANDONED) {
        setClauses.push(`ended_at = NOW()`);
      }
    }

    values.push(id);

    const result = await query<ISessionRow>(
      `UPDATE sessions SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    return result.rows[0] ? mapRowToSession(result.rows[0]) : null;
  }

  /**
   * Increment commits counter
   */
  async incrementCommits(id: string): Promise<ISession | null> {
    logger.debug({ sessionId: id }, 'Incrementing commits in session');

    const result = await query<ISessionRow>(
      `UPDATE sessions SET
        commits_in_session = commits_in_session + 1,
        last_action = 'commit',
        last_action_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [id]
    );

    return result.rows[0] ? mapRowToSession(result.rows[0]) : null;
  }

  /**
   * Update PR info
   */
  async updatePR(
    id: string,
    prId: number,
    prNumber: number,
    prUrl: string
  ): Promise<ISession | null> {
    logger.info({ sessionId: id, prNumber }, 'Updating PR info');

    const result = await query<ISessionRow>(
      `UPDATE sessions SET
        pr_id = $1,
        pr_number = $2,
        pr_url = $3,
        pr_created_at = NOW(),
        last_action = 'pr_created',
        last_action_at = NOW()
      WHERE id = $4
      RETURNING *`,
      [prId, prNumber, prUrl, id]
    );

    return result.rows[0] ? mapRowToSession(result.rows[0]) : null;
  }

  /**
   * Mark session as completed (PR merged)
   */
  async markCompleted(id: string): Promise<ISession | null> {
    logger.info({ sessionId: id }, 'Marking session as completed');

    const result = await query<ISessionRow>(
      `UPDATE sessions SET
        status = 'completed',
        pr_merged_at = NOW(),
        ended_at = NOW(),
        last_action = 'pr_merged',
        last_action_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [id]
    );

    return result.rows[0] ? mapRowToSession(result.rows[0]) : null;
  }

  /**
   * Mark session as abandoned
   */
  async markAbandoned(id: string): Promise<ISession | null> {
    logger.info({ sessionId: id }, 'Marking session as abandoned');

    const result = await query<ISessionRow>(
      `UPDATE sessions SET
        status = 'abandoned',
        ended_at = NOW(),
        last_action = 'session_abandoned',
        last_action_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [id]
    );

    return result.rows[0] ? mapRowToSession(result.rows[0]) : null;
  }

  /**
   * Abandon existing active session for user/repo (called when creating new session)
   */
  private async abandonActiveSession(userId: string, repoId: string): Promise<void> {
    logger.debug({ userId, repoId }, 'Abandoning existing active sessions');

    const result = await query(
      `UPDATE sessions SET
        status = 'abandoned',
        ended_at = NOW(),
        last_action = 'session_superseded',
        last_action_at = NOW()
      WHERE user_id = $1 AND repo_id = $2 AND status = 'active'`,
      [userId, repoId]
    );

    if (result.rowCount && result.rowCount > 0) {
      logger.info({ userId, repoId, count: result.rowCount }, 'Abandoned previous active sessions');
    }
  }

  /**
   * Delete session
   */
  async delete(id: string): Promise<void> {
    logger.warn({ sessionId: id }, 'Deleting session');

    await query(`DELETE FROM sessions WHERE id = $1`, [id]);

    logger.info({ sessionId: id }, 'Session deleted');
  }

  /**
   * Clean up stale sessions (sessions with no activity for X days)
   */
  async cleanupStaleSessions(daysInactive: number = 7): Promise<number> {
    logger.info({ daysInactive }, 'Cleaning up stale sessions');

    const result = await query(
      `UPDATE sessions SET
        status = 'abandoned',
        ended_at = NOW(),
        last_action = 'session_expired',
        last_action_at = NOW()
      WHERE status = 'active' 
        AND last_action_at < NOW() - INTERVAL '1 day' * $1`,
      [daysInactive]
    );

    const count = result.rowCount ?? 0;
    logger.info({ count }, 'Stale sessions cleaned up');

    return count;
  }
}

/**
 * Singleton instance
 */
export const sessionRepository = new SessionRepository();
