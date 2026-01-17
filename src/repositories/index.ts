/**
 * Repository Layer (Data Access)
 *
 * This module exports all data access repositories for the GitFlow MCP Server.
 * Repositories handle database operations and provide a clean abstraction
 * over the data layer.
 *
 * Repositories:
 * - UserRepository: User CRUD operations and authentication data
 * - RepositoryRepository: Git repository records and local paths
 * - SessionRepository: Work session tracking and lifecycle
 */

// Export all repositories
export { UserRepository, userRepository } from './UserRepository.js';
export { RepositoryRepository, repositoryRepository } from './RepositoryRepository.js';
export { SessionRepository, sessionRepository } from './SessionRepository.js';

import type { UserRepository } from './UserRepository.js';
import type { RepositoryRepository } from './RepositoryRepository.js';
import type { SessionRepository } from './SessionRepository.js';

/**
 * Repository container interface for dependency injection
 */
export interface IRepositoryContainer {
  userRepository: UserRepository;
  repositoryRepository: RepositoryRepository;
  sessionRepository: SessionRepository;
}

import { userRepository as userRepositoryInstance } from './UserRepository.js';
import { repositoryRepository as repositoryRepositoryInstance } from './RepositoryRepository.js';
import { sessionRepository as sessionRepositoryInstance } from './SessionRepository.js';

/**
 * Create repository container with initialized repositories
 */
export function createRepositoryContainer(): IRepositoryContainer {
  return {
    userRepository: userRepositoryInstance,
    repositoryRepository: repositoryRepositoryInstance,
    sessionRepository: sessionRepositoryInstance,
  };
}
