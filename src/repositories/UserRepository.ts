/**
 * User Repository
 *
 * Data access layer for user operations.
 * Handles CRUD operations for users table with proper security considerations.
 *
 * SECURITY NOTES:
 * - GitHub tokens should NEVER be logged or exposed
 * - Use parameterized queries to prevent SQL injection
 * - Soft delete for GDPR compliance
 */

import { query, queryOne, transaction, type ITransactionClient } from '../db/client.js';
import { type IUser, type ICreateUserData, UserTier, SubscriptionStatus } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'UserRepository' });

/**
 * Database row type for users table
 */
interface IUserRow {
  id: string;
  github_id: number;
  github_username: string;
  github_email: string | null;
  github_token_encrypted: string;
  github_token_expires_at: Date | null;
  tier: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  subscription_renews_at: Date | null;
  commits_used_this_month: number;
  prs_created_this_month: number;
  repos_accessed_count: number;
  last_reset_at: Date;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
  deleted_at: Date | null;
}

/**
 * Map database row to IUser interface
 */
function mapRowToUser(row: IUserRow): IUser {
  return {
    id: row.id,
    githubId: row.github_id,
    githubUsername: row.github_username,
    githubEmail: row.github_email,
    tier: row.tier as UserTier,
    email: row.email,
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status as SubscriptionStatus | null,
    subscriptionRenewsAt: row.subscription_renews_at,
    commitsUsedThisMonth: row.commits_used_this_month,
    prsCreatedThisMonth: row.prs_created_this_month,
    reposAccessedCount: row.repos_accessed_count,
    lastResetAt: row.last_reset_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    deletedAt: row.deleted_at,
  };
}

/**
 * User Repository class for database operations
 */
export class UserRepository {
  /**
   * Find user by ID
   */
  async findById(id: string): Promise<IUser | null> {
    logger.debug({ userId: id }, 'Finding user by ID');

    const row = await queryOne<IUserRow>(
      `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );

    return row ? mapRowToUser(row) : null;
  }

  /**
   * Find user by GitHub ID
   */
  async findByGitHubId(githubId: number): Promise<IUser | null> {
    logger.debug({ githubId }, 'Finding user by GitHub ID');

    const row = await queryOne<IUserRow>(
      `SELECT * FROM users WHERE github_id = $1 AND deleted_at IS NULL`,
      [githubId]
    );

    return row ? mapRowToUser(row) : null;
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<IUser | null> {
    logger.debug({ email }, 'Finding user by email');

    const row = await queryOne<IUserRow>(
      `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );

    return row ? mapRowToUser(row) : null;
  }

  /**
   * Create a new user
   *
   * @param data - User creation data
   * @param encryptedToken - The encrypted GitHub token (NEVER log this)
   */
  async create(data: ICreateUserData, encryptedToken: string): Promise<IUser> {
    // SECURITY: Never log the token
    logger.info(
      { githubId: data.githubId, githubUsername: data.githubUsername },
      'Creating new user'
    );

    const result = await query<IUserRow>(
      `INSERT INTO users (
        github_id,
        github_username,
        github_email,
        github_token_encrypted,
        email,
        full_name,
        avatar_url,
        tier,
        last_login_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *`,
      [
        data.githubId,
        data.githubUsername,
        data.githubEmail,
        encryptedToken,
        data.email,
        data.fullName,
        data.avatarUrl,
        UserTier.FREE,
      ]
    );

    const user = mapRowToUser(result.rows[0]!);
    logger.info({ userId: user.id, githubUsername: user.githubUsername }, 'User created successfully');

    return user;
  }

  /**
   * Find or create user (upsert pattern for OAuth)
   *
   * @param data - User creation data
   * @param encryptedToken - The encrypted GitHub token (NEVER log this)
   */
  async findOrCreate(data: ICreateUserData, encryptedToken: string): Promise<{ user: IUser; created: boolean }> {
    logger.debug({ githubId: data.githubId }, 'Finding or creating user');

    return await transaction(async (client: ITransactionClient) => {
      // First, try to find existing user
      const existingResult = await client.query<IUserRow>(
        `SELECT * FROM users WHERE github_id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [data.githubId]
      );

      if (existingResult.rows[0]) {
        // User exists - update token and last login
        // SECURITY: Never log the token
        const updateResult = await client.query<IUserRow>(
          `UPDATE users SET
            github_username = $1,
            github_email = $2,
            github_token_encrypted = $3,
            full_name = $4,
            avatar_url = $5,
            last_login_at = NOW()
          WHERE id = $6
          RETURNING *`,
          [
            data.githubUsername,
            data.githubEmail,
            encryptedToken,
            data.fullName,
            data.avatarUrl,
            existingResult.rows[0].id,
          ]
        );

        logger.info(
          { userId: existingResult.rows[0].id, githubUsername: data.githubUsername },
          'Existing user updated on login'
        );

        return {
          user: mapRowToUser(updateResult.rows[0]!),
          created: false,
        };
      }

      // User doesn't exist - create new
      const createResult = await client.query<IUserRow>(
        `INSERT INTO users (
          github_id,
          github_username,
          github_email,
          github_token_encrypted,
          email,
          full_name,
          avatar_url,
          tier,
          last_login_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING *`,
        [
          data.githubId,
          data.githubUsername,
          data.githubEmail,
          encryptedToken,
          data.email,
          data.fullName,
          data.avatarUrl,
          UserTier.FREE,
        ]
      );

      const user = mapRowToUser(createResult.rows[0]!);
      logger.info({ userId: user.id, githubUsername: user.githubUsername }, 'New user created');

      return { user, created: true };
    });
  }

  /**
   * Update user fields
   */
  async update(
    id: string,
    updates: Partial<{
      email: string;
      fullName: string | null;
      avatarUrl: string | null;
      tier: UserTier;
      stripeCustomerId: string | null;
      stripeSubscriptionId: string | null;
      subscriptionStatus: SubscriptionStatus | null;
      subscriptionRenewsAt: Date | null;
    }>
  ): Promise<IUser | null> {
    logger.debug({ userId: id, updates: Object.keys(updates) }, 'Updating user');

    // Build dynamic update query
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.email !== undefined) {
      setClauses.push(`email = $${paramIndex++}`);
      values.push(updates.email);
    }
    if (updates.fullName !== undefined) {
      setClauses.push(`full_name = $${paramIndex++}`);
      values.push(updates.fullName);
    }
    if (updates.avatarUrl !== undefined) {
      setClauses.push(`avatar_url = $${paramIndex++}`);
      values.push(updates.avatarUrl);
    }
    if (updates.tier !== undefined) {
      setClauses.push(`tier = $${paramIndex++}`);
      values.push(updates.tier);
    }
    if (updates.stripeCustomerId !== undefined) {
      setClauses.push(`stripe_customer_id = $${paramIndex++}`);
      values.push(updates.stripeCustomerId);
    }
    if (updates.stripeSubscriptionId !== undefined) {
      setClauses.push(`stripe_subscription_id = $${paramIndex++}`);
      values.push(updates.stripeSubscriptionId);
    }
    if (updates.subscriptionStatus !== undefined) {
      setClauses.push(`subscription_status = $${paramIndex++}`);
      values.push(updates.subscriptionStatus);
    }
    if (updates.subscriptionRenewsAt !== undefined) {
      setClauses.push(`subscription_renews_at = $${paramIndex++}`);
      values.push(updates.subscriptionRenewsAt);
    }

    if (setClauses.length === 0) {
      return this.findById(id);
    }

    values.push(id);

    const result = await query<IUserRow>(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex} AND deleted_at IS NULL
       RETURNING *`,
      values
    );

    return result.rows[0] ? mapRowToUser(result.rows[0]) : null;
  }

  /**
   * Update encrypted token (for token refresh)
   * SECURITY: Token is never logged
   */
  async updateToken(id: string, encryptedToken: string, expiresAt?: Date): Promise<void> {
    // SECURITY: Never log the token, only log that an update occurred
    logger.debug({ userId: id }, 'Updating user token');

    await query(
      `UPDATE users SET
        github_token_encrypted = $1,
        github_token_expires_at = $2
      WHERE id = $3 AND deleted_at IS NULL`,
      [encryptedToken, expiresAt ?? null, id]
    );

    logger.debug({ userId: id }, 'User token updated successfully');
  }

  /**
   * Increment usage counter
   */
  async incrementUsage(
    id: string,
    field: 'commits_used_this_month' | 'prs_created_this_month' | 'repos_accessed_count',
    amount: number = 1
  ): Promise<void> {
    logger.debug({ userId: id, field, amount }, 'Incrementing usage counter');

    await query(
      `UPDATE users SET ${field} = ${field} + $1
       WHERE id = $2 AND deleted_at IS NULL`,
      [amount, id]
    );
  }

  /**
   * Reset monthly usage counters
   */
  async resetMonthlyCounters(id: string): Promise<void> {
    logger.debug({ userId: id }, 'Resetting monthly counters');

    await query(
      `UPDATE users SET
        commits_used_this_month = 0,
        prs_created_this_month = 0,
        last_reset_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
  }

  /**
   * Soft delete user (GDPR compliance)
   */
  async softDelete(id: string): Promise<void> {
    logger.warn({ userId: id }, 'Soft deleting user');

    await query(
      `UPDATE users SET
        deleted_at = NOW(),
        github_token_encrypted = 'REDACTED'
      WHERE id = $1`,
      [id]
    );

    logger.info({ userId: id }, 'User soft deleted (GDPR)');
  }

  /**
   * Get encrypted token from database (fallback when keychain unavailable)
   * SECURITY: This should only be used as fallback
   */
  async getEncryptedToken(id: string): Promise<string | null> {
    // SECURITY: Never log the token
    logger.debug({ userId: id }, 'Retrieving encrypted token from database');

    const result = await queryOne<{ github_token_encrypted: string }>(
      `SELECT github_token_encrypted FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );

    return result?.github_token_encrypted ?? null;
  }
}

/**
 * Singleton instance
 */
export const userRepository = new UserRepository();
