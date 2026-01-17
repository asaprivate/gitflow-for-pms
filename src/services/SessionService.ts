/**
 * Session Service
 *
 * High-level API for managing user work sessions.
 * A session represents a single task/feature from start to completion (merge).
 *
 * RESPONSIBILITIES:
 * - Starting and stopping work sessions
 * - Auto-closing previous sessions when starting new ones
 * - Resuming closed sessions with proper branch checkout
 * - Calculating session duration and statistics
 *
 * INTEGRATIONS:
 * - SessionRepository: Database CRUD operations
 * - RepositoryRepository: Repository information
 * - GitService: Branch checkout for session resume
 */

import { sessionRepository, SessionRepository } from '../repositories/SessionRepository.js';
import { repositoryRepository, RepositoryRepository } from '../repositories/RepositoryRepository.js';
import { GitService } from './GitService.js';
import { type ISession, SessionStatus } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'SessionService' });

// ============================================================================
// Types
// ============================================================================

/**
 * Result of starting a session
 */
export interface IStartSessionResult {
  readonly session: ISession;
  readonly previousSession: ISession | null;
  readonly autoClosed: boolean;
}

/**
 * Result of stopping a session
 */
export interface IStopSessionResult {
  readonly session: ISession;
  readonly durationMinutes: number;
  readonly durationFormatted: string;
}

/**
 * Result of resuming a session
 */
export interface IResumeSessionResult {
  readonly session: ISession;
  readonly branchCheckedOut: boolean;
  readonly reopened: boolean;
}

/**
 * Options for stopping a session
 */
export interface IStopSessionOptions {
  readonly abandoned?: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate duration between two dates in minutes
 */
function calculateDurationMinutes(start: Date, end: Date): number {
  const durationMs = end.getTime() - start.getTime();
  return Math.round(durationMs / 60000);
}

/**
 * Format duration in human-readable format
 */
function formatDuration(minutes: number): string {
  if (minutes < 1) {
    return 'less than a minute';
  }

  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours} hour${hours !== 1 ? 's' : ''}`;
  }

  return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
}

// ============================================================================
// SessionService Class
// ============================================================================

/**
 * Session Service
 *
 * Manages the lifecycle of user work sessions.
 */
export class SessionService {
  private readonly sessionRepo: SessionRepository;
  private readonly repoRepo: RepositoryRepository;

  /**
   * Create a new SessionService instance
   *
   * @param sessionRepo - SessionRepository instance (optional, uses singleton)
   * @param repoRepo - RepositoryRepository instance (optional, uses singleton)
   */
  constructor(
    sessionRepo: SessionRepository = sessionRepository,
    repoRepo: RepositoryRepository = repositoryRepository
  ) {
    this.sessionRepo = sessionRepo;
    this.repoRepo = repoRepo;
  }

  // ==========================================================================
  // Core Session Operations
  // ==========================================================================

  /**
   * Start a new work session
   *
   * If the user already has an active session, it will be automatically closed
   * (marked as abandoned) before the new session is created.
   *
   * @param userId - User ID
   * @param repoId - Repository ID
   * @param taskDescription - Description of the task/feature being worked on
   * @returns Start session result with new session and any auto-closed session
   */
  public async startSession(
    userId: string,
    repoId: string,
    taskDescription: string | null
  ): Promise<IStartSessionResult> {
    logger.info({ userId, repoId, taskDescription }, 'Starting new session');

    // Check for existing active session
    const existingSession = await this.sessionRepo.findActiveByUserId(userId);
    let previousSession: ISession | null = null;
    let autoClosed = false;

    if (existingSession) {
      logger.info(
        { userId, existingSessionId: existingSession.id },
        'Auto-closing existing active session'
      );

      // Auto-close the previous session
      previousSession = await this.sessionRepo.markAbandoned(existingSession.id);
      autoClosed = true;
    }

    // Get repository info to determine current branch
    const repository = await this.repoRepo.findById(repoId);
    if (!repository) {
      throw new Error(`Repository with ID ${repoId} not found.`);
    }

    // Create new session with repository's current branch
    const session = await this.sessionRepo.create({
      userId,
      repoId,
      taskDescription,
      currentBranch: repository.currentBranch,
    });

    logger.info(
      { userId, sessionId: session.id, branch: session.currentBranch, autoClosed },
      'Session started successfully'
    );

    return {
      session,
      previousSession,
      autoClosed,
    };
  }

  /**
   * Stop the active session for a user
   *
   * Calculates the session duration and marks it as completed or abandoned.
   *
   * @param userId - User ID
   * @param options - Optional settings (e.g., mark as abandoned)
   * @returns Stop session result with duration, or null if no active session
   */
  public async stopSession(
    userId: string,
    options?: IStopSessionOptions
  ): Promise<IStopSessionResult | null> {
    logger.info({ userId, options }, 'Stopping session');

    // Find active session
    const activeSession = await this.sessionRepo.findActiveByUserId(userId);

    if (!activeSession) {
      logger.debug({ userId }, 'No active session to stop');
      return null;
    }

    // Calculate duration
    const now = new Date();
    const durationMinutes = calculateDurationMinutes(activeSession.startedAt, now);
    const durationFormatted = formatDuration(durationMinutes);

    // Mark session as completed or abandoned
    let closedSession: ISession | null;

    if (options?.abandoned) {
      closedSession = await this.sessionRepo.markAbandoned(activeSession.id);
    } else {
      closedSession = await this.sessionRepo.markCompleted(activeSession.id);
    }

    if (!closedSession) {
      throw new Error(`Failed to close session ${activeSession.id}`);
    }

    logger.info(
      {
        userId,
        sessionId: closedSession.id,
        status: closedSession.status,
        durationMinutes,
      },
      'Session stopped successfully'
    );

    return {
      session: closedSession,
      durationMinutes,
      durationFormatted,
    };
  }

  /**
   * Get the current active session for a user
   *
   * @param userId - User ID
   * @returns Active session or null if none
   */
  public async getCurrentSession(userId: string): Promise<ISession | null> {
    logger.debug({ userId }, 'Getting current session');
    return this.sessionRepo.findActiveByUserId(userId);
  }

  /**
   * Get session history for a user
   *
   * @param userId - User ID
   * @param limit - Maximum number of sessions to return (default: 5)
   * @returns List of sessions, most recent first
   */
  public async getSessionHistory(
    userId: string,
    limit: number = 5
  ): Promise<readonly ISession[]> {
    logger.debug({ userId, limit }, 'Getting session history');
    return this.sessionRepo.listByUser(userId, undefined, limit);
  }

  /**
   * Resume a closed session
   *
   * This will:
   * 1. Check if the session exists and belongs to the user
   * 2. If closed, re-open it (or create a new one linked to the same repo/branch)
   * 3. Checkout the correct branch using GitService
   *
   * @param sessionId - Session ID to resume
   * @param userId - User ID (for authorization check)
   * @returns Resume session result
   */
  public async resumeSession(
    sessionId: string,
    userId: string
  ): Promise<IResumeSessionResult> {
    logger.info({ sessionId, userId }, 'Resuming session');

    // Find the session
    const session = await this.sessionRepo.findById(sessionId);

    if (!session) {
      throw new Error(`Session with ID ${sessionId} not found.`);
    }

    // Authorization check - session must belong to the user
    if (session.userId !== userId) {
      throw new Error('You do not have permission to resume this session.');
    }

    // Get repository info for git checkout
    const repository = await this.repoRepo.findById(session.repoId);
    if (!repository) {
      throw new Error(`Repository for session not found.`);
    }

    // Check if repository is cloned
    if (!repository.isCloned || !repository.localPath) {
      throw new Error(
        'Repository is not cloned locally. Please clone the repository first.'
      );
    }

    // Auto-close any existing active session for this user
    const currentActive = await this.sessionRepo.findActiveByUserId(userId);
    if (currentActive && currentActive.id !== sessionId) {
      logger.info(
        { userId, existingSessionId: currentActive.id },
        'Auto-closing existing active session before resume'
      );
      await this.sessionRepo.markAbandoned(currentActive.id);
    }

    let resultSession: ISession;
    let reopened = false;
    let branchCheckedOut = false;

    if (session.status === SessionStatus.ACTIVE) {
      // Session is already active - just update last action
      resultSession = (await this.sessionRepo.update(session.id, {
        lastAction: 'session_resumed',
      }))!;
    } else {
      // Session is closed - create a new session linked to the same repo/branch
      reopened = true;

      resultSession = await this.sessionRepo.create({
        userId: session.userId,
        repoId: session.repoId,
        taskDescription: session.taskDescription,
        currentBranch: session.currentBranch,
      });

      logger.info(
        { oldSessionId: sessionId, newSessionId: resultSession.id },
        'Created new session to resume work'
      );
    }

    // Checkout the correct branch using GitService
    try {
      const gitService = GitService.forExistingRepo(userId, repository.localPath);
      await gitService.checkout(resultSession.currentBranch);
      branchCheckedOut = true;

      logger.info(
        { branch: resultSession.currentBranch },
        'Checked out session branch'
      );

      // Update repository's current branch
      await this.repoRepo.updateCurrentBranch(repository.id, resultSession.currentBranch);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(
        { branch: resultSession.currentBranch, error: errorMessage },
        'Failed to checkout branch during session resume'
      );

      // Don't fail the entire operation - session is resumed but branch checkout failed
      // The user can manually checkout the branch
    }

    logger.info(
      { sessionId: resultSession.id, reopened, branchCheckedOut },
      'Session resumed successfully'
    );

    return {
      session: resultSession,
      branchCheckedOut,
      reopened,
    };
  }

  // ==========================================================================
  // Session Updates
  // ==========================================================================

  /**
   * Update session branch after a branch switch or creation
   *
   * @param sessionId - Session ID
   * @param branchName - New branch name
   * @returns Updated session
   */
  public async updateSessionBranch(
    sessionId: string,
    branchName: string
  ): Promise<ISession | null> {
    logger.info({ sessionId, branchName }, 'Updating session branch');

    return this.sessionRepo.update(sessionId, {
      currentBranch: branchName,
      lastAction: 'branch_switched',
    });
  }

  /**
   * Increment the commit counter for a session
   *
   * @param sessionId - Session ID
   * @returns Updated session
   */
  public async incrementCommits(sessionId: string): Promise<ISession | null> {
    logger.debug({ sessionId }, 'Incrementing session commits');
    return this.sessionRepo.incrementCommits(sessionId);
  }

  /**
   * Update session PR info after PR creation
   *
   * @param sessionId - Session ID
   * @param prId - GitHub PR ID
   * @param prNumber - PR number
   * @param prUrl - PR URL
   * @returns Updated session
   */
  public async updateSessionPR(
    sessionId: string,
    prId: number,
    prNumber: number,
    prUrl: string
  ): Promise<ISession | null> {
    logger.info({ sessionId, prNumber }, 'Updating session with PR info');
    return this.sessionRepo.updatePR(sessionId, prId, prNumber, prUrl);
  }

  /**
   * Mark session as completed (typically after PR merge)
   *
   * @param sessionId - Session ID
   * @returns Completed session
   */
  public async markSessionCompleted(sessionId: string): Promise<ISession | null> {
    logger.info({ sessionId }, 'Marking session as completed');
    return this.sessionRepo.markCompleted(sessionId);
  }

  // ==========================================================================
  // Session Queries
  // ==========================================================================

  /**
   * Get session by ID
   *
   * @param sessionId - Session ID
   * @returns Session or null
   */
  public async getSessionById(sessionId: string): Promise<ISession | null> {
    return this.sessionRepo.findById(sessionId);
  }

  /**
   * Get session by ID with authorization check
   *
   * @param sessionId - Session ID
   * @param userId - User ID for authorization
   * @returns Session
   * @throws Error if session not found or user not authorized
   */
  public async getAuthorizedSession(
    sessionId: string,
    userId: string
  ): Promise<ISession> {
    const session = await this.sessionRepo.findById(sessionId);

    if (!session) {
      throw new Error(`Session with ID ${sessionId} not found.`);
    }

    if (session.userId !== userId) {
      throw new Error('You do not have permission to access this session.');
    }

    return session;
  }

  /**
   * Get active session for a user and repository
   *
   * @param userId - User ID
   * @param repoId - Repository ID
   * @returns Active session or null
   */
  public async getActiveSessionForRepo(
    userId: string,
    repoId: string
  ): Promise<ISession | null> {
    return this.sessionRepo.findActiveByUserAndRepo(userId, repoId);
  }

  /**
   * Get sessions for a specific repository
   *
   * @param repoId - Repository ID
   * @param limit - Maximum number of sessions
   * @returns List of sessions
   */
  public async getSessionsForRepo(
    repoId: string,
    limit: number = 10
  ): Promise<readonly ISession[]> {
    return this.sessionRepo.listByRepo(repoId, limit);
  }

  // ==========================================================================
  // Session Statistics
  // ==========================================================================

  /**
   * Calculate statistics for a session
   *
   * @param session - Session to analyze
   * @returns Session statistics
   */
  public getSessionStats(session: ISession): {
    readonly durationMinutes: number;
    readonly durationFormatted: string;
    readonly isActive: boolean;
    readonly hasPR: boolean;
    readonly isMerged: boolean;
  } {
    const endTime = session.endedAt ?? new Date();
    const durationMinutes = calculateDurationMinutes(session.startedAt, endTime);
    const durationFormatted = formatDuration(durationMinutes);

    return {
      durationMinutes,
      durationFormatted,
      isActive: session.status === SessionStatus.ACTIVE,
      hasPR: session.prNumber !== null,
      isMerged: session.prMergedAt !== null,
    };
  }

  // ==========================================================================
  // Cleanup Operations
  // ==========================================================================

  /**
   * Clean up stale sessions
   *
   * Sessions with no activity for the specified number of days will be
   * marked as abandoned.
   *
   * @param daysInactive - Number of days of inactivity (default: 7)
   * @returns Number of sessions cleaned up
   */
  public async cleanupStaleSessions(daysInactive: number = 7): Promise<number> {
    logger.info({ daysInactive }, 'Cleaning up stale sessions');
    return this.sessionRepo.cleanupStaleSessions(daysInactive);
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Singleton instance using default repositories
 */
export const sessionService = new SessionService();
