/**
 * Repository Repository
 *
 * Data access layer for repositories operations.
 * Handles CRUD operations for the repositories table that tracks cloned GitHub repos.
 */

import { query, queryOne, transaction, type ITransactionClient } from '../db/client.js';
import { type IRepository, type ICreateRepositoryData } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'RepositoryRepository' });

/**
 * Database row type for repositories table
 */
interface IRepositoryRow {
  id: string;
  user_id: string;
  github_repo_id: number;
  github_org: string;
  github_name: string;
  github_url: string;
  github_description: string | null;
  github_default_branch: string;
  local_path: string;
  is_cloned: boolean;
  cloned_at: Date | null;
  current_branch: string;
  last_accessed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Map database row to IRepository interface
 */
function mapRowToRepository(row: IRepositoryRow): IRepository {
  return {
    id: row.id,
    userId: row.user_id,
    githubRepoId: row.github_repo_id,
    githubOrg: row.github_org,
    githubName: row.github_name,
    githubUrl: row.github_url,
    githubDescription: row.github_description,
    localPath: row.local_path,
    isCloned: row.is_cloned,
    clonedAt: row.cloned_at,
    currentBranch: row.current_branch,
    lastAccessedAt: row.last_accessed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Repository Repository class for database operations
 */
export class RepositoryRepository {
  /**
   * Find repository by ID
   */
  async findById(id: string): Promise<IRepository | null> {
    logger.debug({ repoId: id }, 'Finding repository by ID');

    const row = await queryOne<IRepositoryRow>(
      `SELECT * FROM repositories WHERE id = $1`,
      [id]
    );

    return row ? mapRowToRepository(row) : null;
  }

  /**
   * Find repository by user ID and GitHub repo ID
   */
  async findByUserAndGitHubRepoId(userId: string, githubRepoId: number): Promise<IRepository | null> {
    logger.debug({ userId, githubRepoId }, 'Finding repository by user and GitHub repo ID');

    const row = await queryOne<IRepositoryRow>(
      `SELECT * FROM repositories WHERE user_id = $1 AND github_repo_id = $2`,
      [userId, githubRepoId]
    );

    return row ? mapRowToRepository(row) : null;
  }

  /**
   * Find repository by local path
   */
  async findByLocalPath(localPath: string): Promise<IRepository | null> {
    logger.debug({ localPath }, 'Finding repository by local path');

    const row = await queryOne<IRepositoryRow>(
      `SELECT * FROM repositories WHERE local_path = $1`,
      [localPath]
    );

    return row ? mapRowToRepository(row) : null;
  }

  /**
   * List all cloned repositories for a user
   */
  async listByUser(userId: string, clonedOnly: boolean = false): Promise<readonly IRepository[]> {
    logger.debug({ userId, clonedOnly }, 'Listing repositories for user');

    const whereClause = clonedOnly
      ? 'WHERE user_id = $1 AND is_cloned = true'
      : 'WHERE user_id = $1';

    const result = await query<IRepositoryRow>(
      `SELECT * FROM repositories ${whereClause} ORDER BY last_accessed_at DESC NULLS LAST`,
      [userId]
    );

    return result.rows.map(mapRowToRepository);
  }

  /**
   * Count repositories for a user
   */
  async countByUser(userId: string, clonedOnly: boolean = false): Promise<number> {
    logger.debug({ userId, clonedOnly }, 'Counting repositories for user');

    const whereClause = clonedOnly
      ? 'WHERE user_id = $1 AND is_cloned = true'
      : 'WHERE user_id = $1';

    const result = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM repositories ${whereClause}`,
      [userId]
    );

    return parseInt(result?.count ?? '0', 10);
  }

  /**
   * Create a new repository record
   */
  async create(data: ICreateRepositoryData): Promise<IRepository> {
    logger.info(
      { userId: data.userId, githubOrg: data.githubOrg, githubName: data.githubName },
      'Creating repository record'
    );

    const result = await query<IRepositoryRow>(
      `INSERT INTO repositories (
        user_id,
        github_repo_id,
        github_org,
        github_name,
        github_url,
        github_description,
        local_path,
        is_cloned,
        current_branch
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'main')
      RETURNING *`,
      [
        data.userId,
        data.githubRepoId,
        data.githubOrg,
        data.githubName,
        data.githubUrl,
        data.githubDescription,
        data.localPath,
      ]
    );

    const repo = mapRowToRepository(result.rows[0]!);
    logger.info({ repoId: repo.id, githubName: repo.githubName }, 'Repository record created');

    return repo;
  }

  /**
   * Find or create repository record
   */
  async findOrCreate(data: ICreateRepositoryData): Promise<{ repository: IRepository; created: boolean }> {
    logger.debug({ userId: data.userId, githubRepoId: data.githubRepoId }, 'Finding or creating repository');

    return await transaction(async (client: ITransactionClient) => {
      // First, try to find existing repository
      const existingResult = await client.query<IRepositoryRow>(
        `SELECT * FROM repositories WHERE user_id = $1 AND github_repo_id = $2 FOR UPDATE`,
        [data.userId, data.githubRepoId]
      );

      if (existingResult.rows[0]) {
        // Repository exists - update description and last accessed
        const updateResult = await client.query<IRepositoryRow>(
          `UPDATE repositories SET
            github_description = $1,
            last_accessed_at = NOW()
          WHERE id = $2
          RETURNING *`,
          [data.githubDescription, existingResult.rows[0].id]
        );

        logger.info(
          { repoId: existingResult.rows[0].id, githubName: data.githubName },
          'Existing repository record updated'
        );

        return {
          repository: mapRowToRepository(updateResult.rows[0]!),
          created: false,
        };
      }

      // Repository doesn't exist - create new
      const createResult = await client.query<IRepositoryRow>(
        `INSERT INTO repositories (
          user_id,
          github_repo_id,
          github_org,
          github_name,
          github_url,
          github_description,
          local_path,
          is_cloned,
          current_branch,
          last_accessed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'main', NOW())
        RETURNING *`,
        [
          data.userId,
          data.githubRepoId,
          data.githubOrg,
          data.githubName,
          data.githubUrl,
          data.githubDescription,
          data.localPath,
        ]
      );

      const repo = mapRowToRepository(createResult.rows[0]!);
      logger.info({ repoId: repo.id, githubName: repo.githubName }, 'New repository record created');

      return { repository: repo, created: true };
    });
  }

  /**
   * Mark repository as cloned
   */
  async markAsCloned(id: string, currentBranch: string = 'main'): Promise<IRepository | null> {
    logger.info({ repoId: id, currentBranch }, 'Marking repository as cloned');

    const result = await query<IRepositoryRow>(
      `UPDATE repositories SET
        is_cloned = true,
        cloned_at = NOW(),
        current_branch = $1,
        last_accessed_at = NOW()
      WHERE id = $2
      RETURNING *`,
      [currentBranch, id]
    );

    return result.rows[0] ? mapRowToRepository(result.rows[0]) : null;
  }

  /**
   * Update current branch
   */
  async updateCurrentBranch(id: string, branch: string): Promise<IRepository | null> {
    logger.debug({ repoId: id, branch }, 'Updating current branch');

    const result = await query<IRepositoryRow>(
      `UPDATE repositories SET
        current_branch = $1,
        last_accessed_at = NOW()
      WHERE id = $2
      RETURNING *`,
      [branch, id]
    );

    return result.rows[0] ? mapRowToRepository(result.rows[0]) : null;
  }

  /**
   * Update last accessed timestamp
   */
  async updateLastAccessed(id: string): Promise<void> {
    logger.debug({ repoId: id }, 'Updating last accessed');

    await query(
      `UPDATE repositories SET last_accessed_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  /**
   * Delete repository record
   */
  async delete(id: string): Promise<void> {
    logger.warn({ repoId: id }, 'Deleting repository record');

    await query(`DELETE FROM repositories WHERE id = $1`, [id]);

    logger.info({ repoId: id }, 'Repository record deleted');
  }

  /**
   * Delete all repositories for a user
   */
  async deleteByUser(userId: string): Promise<number> {
    logger.warn({ userId }, 'Deleting all repositories for user');

    const result = await query(
      `DELETE FROM repositories WHERE user_id = $1`,
      [userId]
    );

    const count = result.rowCount ?? 0;
    logger.info({ userId, count }, 'User repositories deleted');

    return count;
  }
}

/**
 * Singleton instance
 */
export const repositoryRepository = new RepositoryRepository();
