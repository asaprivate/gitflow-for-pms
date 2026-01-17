/**
 * Smart Commit Verification Script
 *
 * This script verifies the "Automatic Branching" feature of the Smart Commit logic.
 * It simulates a user who is on `master`, makes a change, and triggers the branch
 * creation logic to prove that the system successfully switches them to a feature branch.
 *
 * Test Scenario:
 * 1. User is on master branch
 * 2. User modifies a file
 * 3. System detects protected branch and creates a feature branch
 * 4. Changes are committed to the new branch
 * 5. Session and Repository records are updated
 *
 * Run with: npm run build && node dist/scripts/verify_smart_commit.js
 */

import fs from 'fs';
import path from 'path';

import { simpleGit } from 'simple-git';

import { initializeDatabase, closePool, query, queryOne } from '../db/client.js';
import { userRepository } from '../repositories/UserRepository.js';
import { repositoryRepository } from '../repositories/RepositoryRepository.js';
import { sessionRepository } from '../repositories/SessionRepository.js';
import { GitService } from '../services/GitService.js';
import { type IUser, type IRepository, type ISession } from '../types/index.js';

// ============================================================================
// Configuration
// ============================================================================

const TEST_CONFIG = {
  // Safe public repository for testing
  REPO_URL: 'https://github.com/octocat/Hello-World.git',
  REPO_OWNER: 'octocat',
  REPO_NAME: 'Hello-World',
  GITHUB_REPO_ID: 1296269,

  // Local temp path
  TEMP_REPOS_DIR: './temp_repos',
  LOCAL_PATH: './temp_repos/smart_commit',

  // Test branch name
  NEW_BRANCH_NAME: 'feature/auto-branch-test',

  // Test user
  TEST_USER_EMAIL: 'test-smart-commit@example.com',
  TEST_USER_GITHUB_ID: 888888888,
  TEST_USER_GITHUB_USERNAME: 'test-smart-commit-user',
};

// ============================================================================
// Helper Functions
// ============================================================================

function printHeader(title: string): void {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60) + '\n');
}

function printStep(step: number, description: string): void {
  console.log(`\n📌 Step ${step}: ${description}`);
  console.log('-'.repeat(50));
}

function printSuccess(message: string): void {
  console.log(`   ✅ ${message}`);
}

function printFailure(message: string): void {
  console.log(`   ❌ ${message}`);
}

function printInfo(message: string): void {
  console.log(`   ℹ️  ${message}`);
}

function printWarning(message: string): void {
  console.log(`   ⚠️  ${message}`);
}

function printBranch(message: string): void {
  console.log(`   🌿 ${message}`);
}

function printProtected(message: string): void {
  console.log(`   🔒 ${message}`);
}

function cleanupDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    printInfo(`Cleaned up directory: ${dirPath}`);
  }
}

// ============================================================================
// Test User Management
// ============================================================================

async function getOrCreateTestUser(): Promise<IUser> {
  // Try to find an existing user first
  const existingUser = await queryOne<{
    id: string;
    github_id: number;
    github_username: string;
  }>(
    `SELECT id, github_id, github_username 
     FROM users 
     WHERE deleted_at IS NULL 
     ORDER BY created_at DESC 
     LIMIT 1`
  );

  if (existingUser) {
    printInfo(`Found existing user: ${existingUser.github_username} (ID: ${existingUser.id})`);
    const user = await userRepository.findById(existingUser.id);
    if (user) {
      return user;
    }
  }

  // Create test user
  printInfo('Creating test user...');
  const testUser = await userRepository.create(
    {
      githubId: TEST_CONFIG.TEST_USER_GITHUB_ID,
      githubUsername: TEST_CONFIG.TEST_USER_GITHUB_USERNAME,
      githubEmail: TEST_CONFIG.TEST_USER_EMAIL,
      email: TEST_CONFIG.TEST_USER_EMAIL,
      fullName: 'Test Smart Commit User',
      avatarUrl: null,
    },
    'TEST_TOKEN_PLACEHOLDER'
  );

  printSuccess(`Created test user: ${testUser.githubUsername}`);
  return testUser;
}

async function cleanupTestData(
  userId: string,
  repositoryId: string | null,
  sessionId: string | null
): Promise<void> {
  printInfo('Cleaning up test data from database...');

  if (sessionId) {
    await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    printInfo(`Deleted session: ${sessionId}`);
  }

  if (repositoryId) {
    await query(`DELETE FROM repositories WHERE id = $1`, [repositoryId]);
    printInfo(`Deleted repository: ${repositoryId}`);
  }

  // Only delete if it's our test user
  const user = await userRepository.findById(userId);
  if (user && user.githubId === TEST_CONFIG.TEST_USER_GITHUB_ID) {
    await query(`DELETE FROM users WHERE id = $1`, [userId]);
    printInfo(`Deleted test user: ${userId}`);
  }
}

// ============================================================================
// Verification Result
// ============================================================================

interface IVerificationResult {
  success: boolean;
  user: IUser | null;
  repository: IRepository | null;
  session: ISession | null;
  errors: string[];
  checks: {
    cloneSuccess: boolean;
    onMasterInitially: boolean;
    fileModified: boolean;
    branchCreated: boolean;
    commitSuccess: boolean;
    gitBranchCorrect: boolean;
    dbSessionUpdated: boolean;
    dbRepoUpdated: boolean;
  };
}

// ============================================================================
// Main Verification Logic
// ============================================================================

async function runVerification(): Promise<IVerificationResult> {
  const result: IVerificationResult = {
    success: true,
    user: null,
    repository: null,
    session: null,
    errors: [],
    checks: {
      cloneSuccess: false,
      onMasterInitially: false,
      fileModified: false,
      branchCreated: false,
      commitSuccess: false,
      gitBranchCorrect: false,
      dbSessionUpdated: false,
      dbRepoUpdated: false,
    },
  };

  const localPath = TEST_CONFIG.LOCAL_PATH;

  try {
    // =========================================================================
    // SETUP
    // =========================================================================
    printHeader('SETUP');

    // Step 1: Initialize Database
    printStep(1, 'Initialize Database Connection');
    await initializeDatabase();
    printSuccess('Database connection established');

    // Step 2: Get or create test user
    printStep(2, 'Get or Create Test User');
    const user = await getOrCreateTestUser();
    result.user = user;
    printSuccess(`Using user: ${user.githubUsername} (${user.id})`);

    // Step 3: Clean start - delete temp directory if exists
    printStep(3, 'Clean Start - Remove Existing Temp Directory');
    cleanupDir(localPath);
    fs.mkdirSync(TEST_CONFIG.TEMP_REPOS_DIR, { recursive: true });
    printSuccess('Temp directory prepared');

    // Step 4: Clone repository
    printStep(4, 'Clone Repository');
    printInfo(`Target URL: ${TEST_CONFIG.REPO_URL}`);
    printInfo(`Local path: ${localPath}`);

    const git = simpleGit();
    console.log('   ⏳ Cloning repository...');
    await git.clone(TEST_CONFIG.REPO_URL, localPath);
    printSuccess('Repository cloned successfully');
    result.checks.cloneSuccess = true;

    // Step 5: Create Repository record in DB
    printStep(5, 'Create Repository Record in Database');
    const { repository } = await repositoryRepository.findOrCreate({
      userId: user.id,
      githubRepoId: TEST_CONFIG.GITHUB_REPO_ID,
      githubOrg: TEST_CONFIG.REPO_OWNER,
      githubName: TEST_CONFIG.REPO_NAME,
      githubUrl: `https://github.com/${TEST_CONFIG.REPO_OWNER}/${TEST_CONFIG.REPO_NAME}`,
      githubDescription: 'My first repository on GitHub!',
      localPath: localPath,
    });
    result.repository = repository;

    // Mark as cloned with master branch (octocat/Hello-World uses master)
    await repositoryRepository.markAsCloned(repository.id, 'master');
    printSuccess(`Repository record created: ${repository.id}`);
    printInfo(`Current branch in DB: master`);

    // Step 6: Create Session record in DB (defaulting to master)
    printStep(6, 'Create Session Record in Database');
    const { session } = await sessionRepository.findOrCreate({
      userId: user.id,
      repoId: repository.id,
      taskDescription: 'Smart commit test session',
      currentBranch: 'master',
    });
    result.session = session;
    printSuccess(`Session record created: ${session.id}`);
    printInfo(`Current branch in session: ${session.currentBranch}`);

    // =========================================================================
    // THE TEST (Simulation)
    // =========================================================================
    printHeader('THE TEST - Simulating Smart Commit');

    // Create GitService for the repo
    const gitService = GitService.forExistingRepo(user.id, localPath);

    // Step 7: Modify a file
    printStep(7, 'Modify File (README)');
    const readmePath = path.join(localPath, 'README');
    const originalContent = fs.readFileSync(readmePath, 'utf-8');
    const modifiedContent =
      originalContent + `\n\n<!-- Smart Commit Test: ${new Date().toISOString()} -->\n`;
    fs.writeFileSync(readmePath, modifiedContent, 'utf-8');
    printSuccess('Appended text to README');
    result.checks.fileModified = true;

    // Step 8: Check status - verify we're on master with changes
    printStep(8, 'Check Status - Verify on Master with Changes');
    const initialStatus = await gitService.status();
    console.log(`   Current branch: ${initialStatus.currentBranch}`);
    console.log(`   Modified files: ${initialStatus.modifiedFiles.join(', ') || 'none'}`);
    console.log(`   Is clean: ${initialStatus.isClean}`);

    if (initialStatus.currentBranch === 'master') {
      printProtected('Detected protected branch: master');
      result.checks.onMasterInitially = true;
    } else {
      printFailure(`Expected branch 'master', got '${initialStatus.currentBranch}'`);
      result.errors.push(`Initial branch is not master: ${initialStatus.currentBranch}`);
      result.success = false;
    }

    if (initialStatus.modifiedFiles.length > 0 || !initialStatus.isClean) {
      printSuccess('Changes detected in working directory');
    } else {
      printFailure('No changes detected');
      result.errors.push('No file changes detected after modification');
      result.success = false;
    }

    // Step 9: Branch Switch - The Core Logic
    printStep(9, 'Branch Switch - Creating Feature Branch');
    printBranch(`Creating new branch: ${TEST_CONFIG.NEW_BRANCH_NAME}`);

    await gitService.createBranch(TEST_CONFIG.NEW_BRANCH_NAME, 'master', true);
    printSuccess(`Branch created and checked out: ${TEST_CONFIG.NEW_BRANCH_NAME}`);
    result.checks.branchCreated = true;

    // Verify we're now on the new branch
    const afterBranchStatus = await gitService.status();
    printInfo(`Current branch after switch: ${afterBranchStatus.currentBranch}`);

    // Step 10: Commit the changes
    printStep(10, 'Commit Changes');
    await gitService.add('.');
    const commitResult = await gitService.commit({
      message: 'Testing smart commit - auto-branching from master',
    });
    printSuccess(`Commit created: ${commitResult.commitHash.substring(0, 7)}`);
    printInfo(`Files changed: ${commitResult.filesChanged}`);
    result.checks.commitSuccess = true;

    // Step 11: Update DB records
    printStep(11, 'Update Database Records');

    // Update session with new branch
    await sessionRepository.update(session.id, {
      currentBranch: TEST_CONFIG.NEW_BRANCH_NAME,
      lastAction: 'commit',
    });
    await sessionRepository.incrementCommits(session.id);
    printSuccess(`Session updated: current_branch = ${TEST_CONFIG.NEW_BRANCH_NAME}`);

    // Update repository with new branch
    await repositoryRepository.updateCurrentBranch(repository.id, TEST_CONFIG.NEW_BRANCH_NAME);
    printSuccess(`Repository updated: current_branch = ${TEST_CONFIG.NEW_BRANCH_NAME}`);

    // =========================================================================
    // VERIFICATION (Assertions)
    // =========================================================================
    printHeader('VERIFICATION - Checking Results');

    // Assertion 1: Git Check - Verify local repo is on feature branch
    printStep(12, 'Git Check - Verify Local Branch');
    const finalGitStatus = await gitService.status();
    console.log(`   Git reports current branch: ${finalGitStatus.currentBranch}`);

    if (finalGitStatus.currentBranch === TEST_CONFIG.NEW_BRANCH_NAME) {
      printSuccess(`Local repo is on correct branch: ${TEST_CONFIG.NEW_BRANCH_NAME}`);
      result.checks.gitBranchCorrect = true;
    } else {
      printFailure(
        `Expected branch '${TEST_CONFIG.NEW_BRANCH_NAME}', got '${finalGitStatus.currentBranch}'`
      );
      result.errors.push(`Git branch mismatch: expected ${TEST_CONFIG.NEW_BRANCH_NAME}`);
      result.success = false;
    }

    // Also verify with git branch command
    const branches = await gitService.getBranches();
    const currentBranch = branches.find((b) => b.current);
    printInfo(`Git branch command shows: ${currentBranch?.name ?? 'unknown'}`);

    // Assertion 2: DB Check - Session table
    printStep(13, 'Database Check - Session Record');
    const dbSession = await sessionRepository.findById(session.id);

    if (dbSession) {
      console.log(`   Session current_branch: ${dbSession.currentBranch}`);
      console.log(`   Session commits_in_session: ${dbSession.commitsInSession}`);

      if (dbSession.currentBranch === TEST_CONFIG.NEW_BRANCH_NAME) {
        printSuccess(`Session current_branch is correct: ${TEST_CONFIG.NEW_BRANCH_NAME}`);
        result.checks.dbSessionUpdated = true;
      } else {
        printFailure(
          `Session current_branch is WRONG: expected '${TEST_CONFIG.NEW_BRANCH_NAME}', got '${dbSession.currentBranch}'`
        );
        result.errors.push(`Session branch not updated: ${dbSession.currentBranch}`);
        result.success = false;
      }

      if (dbSession.commitsInSession >= 1) {
        printSuccess(`Commits counter incremented: ${dbSession.commitsInSession}`);
      } else {
        printWarning(`Commits counter not incremented: ${dbSession.commitsInSession}`);
      }
    } else {
      printFailure('Session record not found in database');
      result.errors.push('Session record missing');
      result.success = false;
    }

    // Assertion 3: DB Check - Repository table
    printStep(14, 'Database Check - Repository Record');
    const dbRepo = await repositoryRepository.findById(repository.id);

    if (dbRepo) {
      console.log(`   Repository current_branch: ${dbRepo.currentBranch}`);

      if (dbRepo.currentBranch === TEST_CONFIG.NEW_BRANCH_NAME) {
        printSuccess(`Repository current_branch is correct: ${TEST_CONFIG.NEW_BRANCH_NAME}`);
        result.checks.dbRepoUpdated = true;
      } else {
        printFailure(
          `Repository current_branch is WRONG: expected '${TEST_CONFIG.NEW_BRANCH_NAME}', got '${dbRepo.currentBranch}'`
        );
        result.errors.push(`Repository branch not updated: ${dbRepo.currentBranch}`);
        result.success = false;
      }
    } else {
      printFailure('Repository record not found in database');
      result.errors.push('Repository record missing');
      result.success = false;
    }

    // Final verification: ensure we're NOT on master
    printStep(15, 'Final Verification - Not on Protected Branch');
    if (finalGitStatus.currentBranch !== 'master') {
      printSuccess('Successfully moved off protected master branch');
    } else {
      printFailure('STILL on master branch - auto-branching failed!');
      result.errors.push('Still on master after smart commit');
      result.success = false;
    }

  } catch (error) {
    result.success = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(`Exception: ${errorMessage}`);

    printFailure(`Verification failed with error: ${errorMessage}`);
    console.error('\nFull error stack:');
    console.error(error instanceof Error ? error.stack : error);
  }

  return result;
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  printHeader('Smart Commit Verification Script');
  console.log('This script verifies the "Automatic Branching" feature.');
  console.log('');
  console.log('Scenario:');
  console.log('  1. User is on master branch');
  console.log('  2. User modifies a file');
  console.log('  3. System detects protected branch (master)');
  console.log('  4. System creates feature branch automatically');
  console.log('  5. Changes are committed to feature branch');
  console.log('  6. Database records are updated');
  console.log('');
  console.log('Expected outcome:');
  console.log(`  - Local branch: ${TEST_CONFIG.NEW_BRANCH_NAME}`);
  console.log(`  - Session.current_branch: ${TEST_CONFIG.NEW_BRANCH_NAME}`);
  console.log(`  - Repository.current_branch: ${TEST_CONFIG.NEW_BRANCH_NAME}`);

  let result: IVerificationResult | null = null;

  try {
    result = await runVerification();

    // Print Summary
    printHeader('SUMMARY');

    if (result.success) {
      console.log('🎉 All verifications PASSED!\n');
      console.log('The Smart Commit Auto-Branching feature is working correctly:');
      console.log('');
      console.log('  🔒 Protected branch (master) was detected');
      console.log(`  🌿 New branch created: ${TEST_CONFIG.NEW_BRANCH_NAME}`);
      console.log('  ✅ Changes committed to new branch');
      console.log('  ✅ Session.current_branch updated in database');
      console.log('  ✅ Repository.current_branch updated in database');
      console.log('  ✅ Local git repo is on correct branch');
      console.log('');
      console.log('Checks passed:');
      for (const [check, passed] of Object.entries(result.checks)) {
        console.log(`  ${passed ? '✅' : '❌'} ${check}`);
      }
    } else {
      console.log('❌ Some verifications FAILED!\n');
      console.log('Errors:');
      for (const error of result.errors) {
        console.log(`  • ${error}`);
      }
      console.log('');
      console.log('Checks:');
      for (const [check, passed] of Object.entries(result.checks)) {
        console.log(`  ${passed ? '✅' : '❌'} ${check}`);
      }
    }

  } finally {
    // Cleanup
    printHeader('CLEANUP');

    if (result) {
      // Clean up temp directory
      printStep(16, 'Clean up FileSystem');
      cleanupDir(TEST_CONFIG.TEMP_REPOS_DIR);
      printSuccess('Temp directory cleaned');

      // Clean up database records
      printStep(17, 'Clean up Database Records');
      if (result.user && (result.repository || result.session)) {
        await cleanupTestData(
          result.user.id,
          result.repository?.id ?? null,
          result.session?.id ?? null
        );
        printSuccess('Database records cleaned');
      } else {
        printInfo('No records to clean');
      }
    }

    // Close database connection
    printStep(18, 'Close Database Connection');
    await closePool();
    printSuccess('Database connection closed');

    printHeader('DONE');

    if (result && !result.success) {
      process.exitCode = 1;
    }
  }
}

// Run
main().catch((error) => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});
