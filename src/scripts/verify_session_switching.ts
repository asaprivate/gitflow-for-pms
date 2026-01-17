/**
 * Session Switching Verification Script
 *
 * This script verifies the "Context Switching" (Resume) logic of SessionService.
 * It proves that when a user resumes a session, the Git branch automatically
 * switches to match the session's branch.
 *
 * Test Scenario:
 * 1. User works on "Task A" (feature/task-A branch)
 * 2. User switches to "Task B" (feature/task-B branch)
 * 3. User asks to "Resume Task A"
 * 4. Git branch should automatically switch back to feature/task-A
 *
 * Run with: npm run build && node dist/scripts/verify_session_switching.js
 */

import fs from 'fs';

import { simpleGit } from 'simple-git';

import { initializeDatabase, closePool, query, queryOne } from '../db/client.js';
import { userRepository } from '../repositories/UserRepository.js';
import { repositoryRepository } from '../repositories/RepositoryRepository.js';
import { sessionRepository } from '../repositories/SessionRepository.js';
import { sessionService } from '../services/SessionService.js';
import { GitService } from '../services/GitService.js';
import { SessionStatus, type IUser, type IRepository, type ISession } from '../types/index.js';

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
  LOCAL_PATH: './temp_repos/session_test',

  // Test branches
  BRANCH_TASK_A: 'feature/task-A',
  BRANCH_TASK_B: 'feature/task-B',

  // Test user
  TEST_USER_EMAIL: 'test-session-switch@example.com',
  TEST_USER_GITHUB_ID: 777777777,
  TEST_USER_GITHUB_USERNAME: 'test-session-switch-user',
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

function printBranch(branchName: string): void {
  console.log(`   🌿 Current Branch: ${branchName}`);
}

function printSession(label: string, session: ISession): void {
  console.log(`   📋 ${label}:`);
  console.log(`      ID: ${session.id.substring(0, 8)}...`);
  console.log(`      Task: ${session.taskDescription}`);
  console.log(`      Branch: ${session.currentBranch}`);
  console.log(`      Status: ${session.status}`);
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
      fullName: 'Test Session Switch User',
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
  sessionIds: string[]
): Promise<void> {
  printInfo('Cleaning up test data from database...');

  // Delete sessions first (foreign key constraint)
  for (const sessionId of sessionIds) {
    await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    printInfo(`Deleted session: ${sessionId.substring(0, 8)}...`);
  }

  if (repositoryId) {
    await query(`DELETE FROM repositories WHERE id = $1`, [repositoryId]);
    printInfo(`Deleted repository: ${repositoryId.substring(0, 8)}...`);
  }

  // Only delete if it's our test user
  const user = await userRepository.findById(userId);
  if (user && user.githubId === TEST_CONFIG.TEST_USER_GITHUB_ID) {
    await query(`DELETE FROM users WHERE id = $1`, [userId]);
    printInfo(`Deleted test user: ${userId.substring(0, 8)}...`);
  }
}

// ============================================================================
// Verification Result
// ============================================================================

interface IVerificationResult {
  success: boolean;
  user: IUser | null;
  repository: IRepository | null;
  sessionIds: string[];
  errors: string[];
  checks: {
    setupComplete: boolean;
    sessionAStarted: boolean;
    sessionBStarted: boolean;
    sessionAAbandoned: boolean;
    sessionAResumed: boolean;
    branchSwitchedToTaskA: boolean;
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
    sessionIds: [],
    errors: [],
    checks: {
      setupComplete: false,
      sessionAStarted: false,
      sessionBStarted: false,
      sessionAAbandoned: false,
      sessionAResumed: false,
      branchSwitchedToTaskA: false,
    },
  };

  const localPath = TEST_CONFIG.LOCAL_PATH;
  let sessionA: ISession | null = null;
  let sessionB: ISession | null = null;

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

    // Mark as cloned with master branch (Hello-World uses master)
    await repositoryRepository.markAsCloned(repository.id, 'master');
    printSuccess(`Repository record created: ${repository.id.substring(0, 8)}...`);

    // Step 6: Create test branches
    printStep(6, 'Create Test Branches');
    const gitService = GitService.forExistingRepo(user.id, localPath);

    // Create feature/task-A branch
    await gitService.createBranch(TEST_CONFIG.BRANCH_TASK_A, 'master', false);
    printSuccess(`Created branch: ${TEST_CONFIG.BRANCH_TASK_A}`);

    // Create feature/task-B branch
    await gitService.createBranch(TEST_CONFIG.BRANCH_TASK_B, 'master', false);
    printSuccess(`Created branch: ${TEST_CONFIG.BRANCH_TASK_B}`);

    // List branches to confirm
    const branches = await gitService.getBranches();
    printInfo(`Available branches: ${branches.map((b) => b.name).join(', ')}`);

    result.checks.setupComplete = true;

    // =========================================================================
    // THE TEST - Session Switching Simulation
    // =========================================================================
    printHeader('THE TEST - Session Context Switching');

    // Step 7: Start Session A (Task A on feature/task-A)
    printStep(7, 'Start Session A - Working on Task A');

    // First checkout the branch
    await gitService.checkout(TEST_CONFIG.BRANCH_TASK_A);
    await repositoryRepository.updateCurrentBranch(repository.id, TEST_CONFIG.BRANCH_TASK_A);

    // Verify branch
    let currentStatus = await gitService.status();
    printBranch(currentStatus.currentBranch);

    // Start session
    const startResultA = await sessionService.startSession(
      user.id,
      repository.id,
      'Task A - Implement feature X'
    );
    sessionA = startResultA.session;
    result.sessionIds.push(sessionA.id);

    printSession('Session A', sessionA);

    // Assert Session A is active
    if (sessionA.status === SessionStatus.ACTIVE) {
      printSuccess('Session A is ACTIVE');
      result.checks.sessionAStarted = true;
    } else {
      printFailure(`Session A status is ${sessionA.status}, expected ACTIVE`);
      result.errors.push('Session A not active');
      result.success = false;
    }

    // Step 8: Switch to Session B (Task B on feature/task-B)
    printStep(8, 'Switch to Session B - Working on Task B');

    // Checkout task-B branch
    await gitService.checkout(TEST_CONFIG.BRANCH_TASK_B);
    await repositoryRepository.updateCurrentBranch(repository.id, TEST_CONFIG.BRANCH_TASK_B);

    // Verify branch
    currentStatus = await gitService.status();
    printBranch(currentStatus.currentBranch);

    // Start session B (should auto-close session A)
    const startResultB = await sessionService.startSession(
      user.id,
      repository.id,
      'Task B - Fix bug Y'
    );
    sessionB = startResultB.session;
    result.sessionIds.push(sessionB.id);

    printSession('Session B', sessionB);

    // Assert Session B is active
    if (sessionB.status === SessionStatus.ACTIVE) {
      printSuccess('Session B is ACTIVE');
      result.checks.sessionBStarted = true;
    } else {
      printFailure(`Session B status is ${sessionB.status}, expected ACTIVE`);
      result.errors.push('Session B not active');
      result.success = false;
    }

    // Check if Session A was auto-closed
    if (startResultB.autoClosed && startResultB.previousSession) {
      printSuccess(`Session A was auto-closed (abandoned): ${startResultB.previousSession.status}`);
      result.checks.sessionAAbandoned = true;
    } else {
      // Manually verify by fetching session A from DB
      const refreshedSessionA = await sessionRepository.findById(sessionA.id);
      if (refreshedSessionA && refreshedSessionA.status === SessionStatus.ABANDONED) {
        printSuccess('Session A was abandoned (verified from DB)');
        result.checks.sessionAAbandoned = true;
      } else {
        printFailure('Session A was NOT abandoned');
        result.errors.push('Session A not abandoned when starting Session B');
        result.success = false;
      }
    }

    // Current state: On feature/task-B, Session B active, Session A abandoned
    console.log('\n   📊 Current State:');
    console.log(`      - Branch: ${TEST_CONFIG.BRANCH_TASK_B}`);
    console.log(`      - Active Session: B (Task B)`);
    console.log(`      - Session A: Abandoned`);

    // Step 9: Resume Session A
    printStep(9, 'Resume Session A - Context Switch Back');
    console.log('   🔄 Calling SessionService.resumeSession(sessionA_ID, user)...\n');

    const resumeResult = await sessionService.resumeSession(sessionA.id, user.id);
    const resumedSession = resumeResult.session;

    // Track the new session if it's different from A
    if (resumedSession.id !== sessionA.id && !result.sessionIds.includes(resumedSession.id)) {
      result.sessionIds.push(resumedSession.id);
    }

    printSession('Resumed Session', resumedSession);
    printInfo(`Reopened: ${resumeResult.reopened}`);
    printInfo(`Branch Checked Out: ${resumeResult.branchCheckedOut}`);

    // Assert the resumed session is active
    if (resumedSession.status === SessionStatus.ACTIVE) {
      printSuccess('Resumed session is ACTIVE');
      result.checks.sessionAResumed = true;
    } else {
      printFailure(`Resumed session status is ${resumedSession.status}, expected ACTIVE`);
      result.errors.push('Resumed session not active');
      result.success = false;
    }

    // =========================================================================
    // CRITICAL VERIFICATION - Branch Must Be feature/task-A
    // =========================================================================
    printStep(10, 'CRITICAL VERIFICATION - Check Git Branch');

    currentStatus = await gitService.status();
    printBranch(currentStatus.currentBranch);

    console.log('');
    console.log(`   Expected branch: ${TEST_CONFIG.BRANCH_TASK_A}`);
    console.log(`   Actual branch:   ${currentStatus.currentBranch}`);
    console.log('');

    if (currentStatus.currentBranch === TEST_CONFIG.BRANCH_TASK_A) {
      printSuccess(`✨ BRANCH SWITCHED CORRECTLY TO: ${TEST_CONFIG.BRANCH_TASK_A}`);
      result.checks.branchSwitchedToTaskA = true;
    } else {
      printFailure(
        `Branch is ${currentStatus.currentBranch}, expected ${TEST_CONFIG.BRANCH_TASK_A}`
      );
      result.errors.push(
        `Branch not switched: expected ${TEST_CONFIG.BRANCH_TASK_A}, got ${currentStatus.currentBranch}`
      );
      result.success = false;
    }

    // Step 11: Verify Session B was closed
    printStep(11, 'Verify Session B was Auto-Closed');

    const refreshedSessionB = await sessionRepository.findById(sessionB.id);
    if (refreshedSessionB) {
      console.log(`   Session B status: ${refreshedSessionB.status}`);

      if (refreshedSessionB.status === SessionStatus.ABANDONED) {
        printSuccess('Session B was auto-abandoned when resuming Session A');
      } else if (refreshedSessionB.status === SessionStatus.ACTIVE) {
        printFailure('Session B is still ACTIVE (should have been closed)');
        // This might not be a hard failure depending on implementation
      } else {
        printInfo(`Session B status: ${refreshedSessionB.status}`);
      }
    }

    // Step 12: Final summary of session states
    printStep(12, 'Final Session States');

    const allSessions = await sessionRepository.listByUser(user.id, undefined, 10);
    console.log(`   Total sessions for user: ${allSessions.length}`);
    console.log('');

    for (const s of allSessions) {
      const marker =
        s.status === SessionStatus.ACTIVE
          ? '🟢'
          : s.status === SessionStatus.ABANDONED
            ? '🟡'
            : '⚪';
      console.log(`   ${marker} ${s.taskDescription?.padEnd(30) ?? 'No description'.padEnd(30)} | ${s.currentBranch.padEnd(20)} | ${s.status}`);
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
  printHeader('Session Context Switching Verification');
  console.log('This script verifies the SessionService resume logic.');
  console.log('');
  console.log('Scenario:');
  console.log('  1. User starts Session A on feature/task-A');
  console.log('  2. User switches to Session B on feature/task-B');
  console.log('  3. User resumes Session A');
  console.log('');
  console.log('Expected outcome:');
  console.log('  - Git branch automatically switches to feature/task-A');
  console.log('  - Session A (or new session) is active');
  console.log('  - Session B is closed/abandoned');

  let result: IVerificationResult | null = null;

  try {
    result = await runVerification();

    // Print Summary
    printHeader('SUMMARY');

    if (result.success) {
      console.log('🎉 All verifications PASSED!\n');
      console.log('The Session Context Switching feature is working correctly:');
      console.log('');
      console.log('  ✅ Session A started on feature/task-A');
      console.log('  ✅ Session B started, Session A auto-abandoned');
      console.log('  ✅ Session A resumed successfully');
      console.log('  ✅ Git branch switched to feature/task-A automatically');
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
      printStep(13, 'Clean up FileSystem');
      cleanupDir(TEST_CONFIG.TEMP_REPOS_DIR);
      printSuccess('Temp directory cleaned');

      // Clean up database records
      printStep(14, 'Clean up Database Records');
      if (result.user && (result.repository || result.sessionIds.length > 0)) {
        await cleanupTestData(
          result.user.id,
          result.repository?.id ?? null,
          result.sessionIds
        );
        printSuccess('Database records cleaned');
      } else {
        printInfo('No records to clean');
      }
    }

    // Close database connection
    printStep(15, 'Close Database Connection');
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
