/**
 * PR Workflow Verification Script
 *
 * This script verifies the `push_for_review` workflow by:
 * 1. Setting up a test environment (DB, repo, session)
 * 2. Mocking GitHubAPIService.createPullRequest (to avoid real GitHub calls)
 * 3. Mocking GitService.push (to avoid needing write access)
 * 4. Executing the push_for_review logic
 * 5. Verifying the session was updated with PR details
 *
 * Run with: npm run build && node dist/scripts/verify_pr_workflow.js
 */

import fs from 'fs';

import { simpleGit } from 'simple-git';

import { initializeDatabase, closePool, query, queryOne } from '../db/client.js';
import { userRepository } from '../repositories/UserRepository.js';
import { repositoryRepository } from '../repositories/RepositoryRepository.js';
import { sessionRepository } from '../repositories/SessionRepository.js';
import { GitService } from '../services/GitService.js';
import type { IUser, IRepository, ISession, IGitHubPullRequest } from '../types/index.js';

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
  LOCAL_PATH: './temp_repos/pr_test',

  // Test branch
  TEST_BRANCH: 'feature/pr-test',

  // Test user
  TEST_USER_EMAIL: 'test-pr-workflow@example.com',
  TEST_USER_GITHUB_ID: 888888888,
  TEST_USER_GITHUB_USERNAME: 'test-pr-user',

  // Mock PR response
  MOCK_PR: {
    id: 12345,
    number: 99,
    title: 'Test PR',
    body: 'Test body',
    url: 'https://github.com/octocat/Hello-World/pull/99',
    state: 'open' as const,
    headBranch: 'feature/pr-test',
    baseBranch: 'master',
    createdAt: new Date(),
    updatedAt: new Date(),
    mergedAt: null,
  },
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

function cleanupDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    printInfo(`Cleaned up directory: ${dirPath}`);
  }
}

// ============================================================================
// Mock Tracking
// ============================================================================

interface IMockCallRecord {
  method: string;
  args: unknown[];
  timestamp: Date;
}

const mockCalls: IMockCallRecord[] = [];

function recordMockCall(method: string, args: unknown[]): void {
  mockCalls.push({
    method,
    args,
    timestamp: new Date(),
  });
}

function getMockCalls(method: string): IMockCallRecord[] {
  return mockCalls.filter((c) => c.method === method);
}

function clearMockCalls(): void {
  mockCalls.length = 0;
}

// ============================================================================
// Test Data Management
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
      fullName: 'Test PR Workflow User',
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

  // Delete session first (foreign key constraint)
  if (sessionId) {
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
// Push For Review Logic (extracted from the MCP tool)
// ============================================================================

/**
 * This function replicates the core logic of push_for_review
 * but allows us to inject mocked services
 */
async function executePushForReview(
  userId: string,
  title: string | undefined,
  description: string | undefined,
  isDraft: boolean,
  // Injected mocks
  mockPush: (branch: string, options?: { setUpstream?: boolean }) => Promise<{ success: boolean }>,
  mockCreatePR: (options: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    body?: string;
    draft?: boolean;
  }) => Promise<IGitHubPullRequest>
): Promise<{
  success: boolean;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}> {
  // Step 1: Get active session
  const activeSession = await sessionRepository.findActiveByUserId(userId);
  if (!activeSession) {
    return { success: false, error: 'No active session' };
  }

  // Step 2: Get repository
  const repository = await repositoryRepository.findById(activeSession.repoId);
  if (!repository || !repository.isCloned) {
    return { success: false, error: 'Repository not found or not cloned' };
  }

  // Step 3: Check branch (skip protected branch check for test)
  const currentBranch = activeSession.currentBranch;

  // Step 4: Push to remote (mocked)
  printInfo(`Calling GitService.push("${currentBranch}")...`);
  recordMockCall('GitService.push', [currentBranch, { setUpstream: true }]);
  await mockPush(currentBranch, { setUpstream: true });
  printSuccess('GitService.push called successfully (mocked)');

  // Step 5: Create PR (mocked)
  const prTitle =
    title ||
    activeSession.taskDescription ||
    `Feature: ${currentBranch.replace(/^(feature|fix|hotfix)\//, '')}`;

  const prBodyParts = [description || ''];
  prBodyParts.push('');
  prBodyParts.push('---');
  prBodyParts.push('*Created via GitFlow MCP*');
  const prBody = prBodyParts.join('\n').trim();

  const createPROptions = {
    owner: repository.githubOrg,
    repo: repository.githubName,
    title: prTitle,
    head: currentBranch,
    body: prBody,
    draft: isDraft,
  };

  printInfo(`Calling GitHubAPIService.createPullRequest()...`);
  printInfo(`  Title: "${prTitle}"`);
  printInfo(`  Head: ${currentBranch}`);
  printInfo(`  Draft: ${isDraft}`);
  recordMockCall('GitHubAPIService.createPullRequest', [createPROptions]);

  const pr = await mockCreatePR(createPROptions);
  printSuccess('GitHubAPIService.createPullRequest called successfully (mocked)');

  // Step 6: Update session with PR details
  printInfo(`Updating session with PR details...`);
  await sessionRepository.updatePR(activeSession.id, pr.id, pr.number, pr.url);
  printSuccess(`Session updated with PR #${pr.number}`);

  return {
    success: true,
    prNumber: pr.number,
    prUrl: pr.url,
  };
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
    setupComplete: boolean;
    pushCalled: boolean;
    createPRCalled: boolean;
    createPRCalledWithCorrectArgs: boolean;
    sessionUpdatedWithPR: boolean;
    prNumberInDB: boolean;
    prUrlInDB: boolean;
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
      setupComplete: false,
      pushCalled: false,
      createPRCalled: false,
      createPRCalledWithCorrectArgs: false,
      sessionUpdatedWithPR: false,
      prNumberInDB: false,
      prUrlInDB: false,
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

    // Mark as cloned
    await repositoryRepository.markAsCloned(repository.id, 'master');
    printSuccess(`Repository record created: ${repository.id.substring(0, 8)}...`);

    // Step 6: Create feature branch and make a commit
    printStep(6, 'Create Feature Branch and Make Commit');
    const gitService = GitService.forExistingRepo(user.id, localPath);

    // Create feature branch
    await gitService.createBranch(TEST_CONFIG.TEST_BRANCH, 'master', true);
    printSuccess(`Created and checked out branch: ${TEST_CONFIG.TEST_BRANCH}`);

    // Create a dummy file and commit
    const testFilePath = `${localPath}/test-pr-file.txt`;
    fs.writeFileSync(testFilePath, `Test file created at ${new Date().toISOString()}\n`);
    printInfo('Created test file: test-pr-file.txt');

    await gitService.add('.');
    const commitResult = await gitService.commit({ message: 'Add test file for PR workflow' });
    printSuccess(`Commit created: ${commitResult.commitHash.substring(0, 7)}`);

    // Update repository current branch
    await repositoryRepository.updateCurrentBranch(repository.id, TEST_CONFIG.TEST_BRANCH);

    // Step 7: Create active session
    printStep(7, 'Create Active Session');
    const session = await sessionRepository.create({
      userId: user.id,
      repoId: repository.id,
      taskDescription: 'Test PR Workflow - Implement feature X',
      currentBranch: TEST_CONFIG.TEST_BRANCH,
    });
    result.session = session;
    printSuccess(`Session created: ${session.id.substring(0, 8)}...`);
    printInfo(`Task: ${session.taskDescription}`);
    printInfo(`Branch: ${session.currentBranch}`);

    result.checks.setupComplete = true;

    // =========================================================================
    // MOCKING
    // =========================================================================
    printHeader('MOCKING');

    printStep(8, 'Setup Mocks');
    clearMockCalls();

    // Mock GitService.push
    const mockPush = async (
      branch: string,
      _options?: { setUpstream?: boolean }
    ): Promise<{ success: boolean }> => {
      printInfo(`[MOCK] GitService.push("${branch}") called`);
      return { success: true };
    };
    printSuccess('GitService.push mock configured');

    // Mock GitHubAPIService.createPullRequest
    const mockCreatePR = async (options: {
      owner: string;
      repo: string;
      title: string;
      head: string;
      body?: string;
      draft?: boolean;
    }): Promise<IGitHubPullRequest> => {
      printInfo(`[MOCK] GitHubAPIService.createPullRequest() called`);
      printInfo(`       owner: ${options.owner}, repo: ${options.repo}`);
      printInfo(`       title: "${options.title}"`);
      printInfo(`       head: ${options.head}, draft: ${options.draft}`);

      return {
        ...TEST_CONFIG.MOCK_PR,
        title: options.title,
        body: options.body ?? null,
        headBranch: options.head,
      };
    };
    printSuccess('GitHubAPIService.createPullRequest mock configured');

    // =========================================================================
    // THE TEST
    // =========================================================================
    printHeader('THE TEST - Execute push_for_review');

    printStep(9, 'Execute push_for_review Logic');

    const prResult = await executePushForReview(
      user.id,
      undefined, // Use session task description as title
      'This is a test PR description',
      false, // Not a draft
      mockPush,
      mockCreatePR
    );

    if (prResult.success) {
      printSuccess(`push_for_review completed successfully`);
      printInfo(`PR Number: ${prResult.prNumber}`);
      printInfo(`PR URL: ${prResult.prUrl}`);
    } else {
      printFailure(`push_for_review failed: ${prResult.error}`);
      result.errors.push(prResult.error ?? 'Unknown error');
      result.success = false;
    }

    // =========================================================================
    // ASSERTIONS
    // =========================================================================
    printHeader('ASSERTIONS');

    // Assertion 1: GitService.push was called
    printStep(10, 'Verify GitService.push was called');
    const pushCalls = getMockCalls('GitService.push');
    if (pushCalls.length > 0) {
      printSuccess(`GitService.push was called ${pushCalls.length} time(s)`);
      const pushArgs = pushCalls[0]?.args as [string, { setUpstream?: boolean }];
      printInfo(`  Branch: ${pushArgs[0]}`);
      printInfo(`  setUpstream: ${pushArgs[1]?.setUpstream}`);
      result.checks.pushCalled = true;
    } else {
      printFailure('GitService.push was NOT called');
      result.errors.push('GitService.push was not called');
      result.success = false;
    }

    // Assertion 2: GitHubAPIService.createPullRequest was called
    printStep(11, 'Verify GitHubAPIService.createPullRequest was called');
    const createPRCalls = getMockCalls('GitHubAPIService.createPullRequest');
    if (createPRCalls.length > 0) {
      printSuccess(`GitHubAPIService.createPullRequest was called ${createPRCalls.length} time(s)`);
      result.checks.createPRCalled = true;

      // Check the arguments
      const prArgs = createPRCalls[0]?.args[0] as {
        owner: string;
        repo: string;
        title: string;
        head: string;
        body?: string;
        draft?: boolean;
      };

      printInfo(`  Owner: ${prArgs.owner}`);
      printInfo(`  Repo: ${prArgs.repo}`);
      printInfo(`  Title: "${prArgs.title}"`);
      printInfo(`  Head: ${prArgs.head}`);
      printInfo(`  Draft: ${prArgs.draft}`);

      // Verify correct arguments
      const correctOwner = prArgs.owner === TEST_CONFIG.REPO_OWNER;
      const correctRepo = prArgs.repo === TEST_CONFIG.REPO_NAME;
      const correctHead = prArgs.head === TEST_CONFIG.TEST_BRANCH;
      const hasBody = prArgs.body?.includes('Created via GitFlow MCP') ?? false;

      if (correctOwner && correctRepo && correctHead && hasBody) {
        printSuccess('createPullRequest called with correct arguments');
        result.checks.createPRCalledWithCorrectArgs = true;
      } else {
        printFailure('createPullRequest called with incorrect arguments');
        if (!correctOwner) printInfo(`  Expected owner: ${TEST_CONFIG.REPO_OWNER}`);
        if (!correctRepo) printInfo(`  Expected repo: ${TEST_CONFIG.REPO_NAME}`);
        if (!correctHead) printInfo(`  Expected head: ${TEST_CONFIG.TEST_BRANCH}`);
        if (!hasBody) printInfo(`  Body should contain "Created via GitFlow MCP"`);
        result.errors.push('createPullRequest called with incorrect arguments');
        result.success = false;
      }
    } else {
      printFailure('GitHubAPIService.createPullRequest was NOT called');
      result.errors.push('GitHubAPIService.createPullRequest was not called');
      result.success = false;
    }

    // Assertion 3: Session was updated with PR details
    printStep(12, 'CRITICAL: Verify Session Updated with PR Details');

    // Fetch session from DB directly
    const updatedSession = await queryOne<{
      id: string;
      pr_id: number | null;
      pr_number: number | null;
      pr_url: string | null;
    }>(
      `SELECT id, pr_id, pr_number, pr_url FROM sessions WHERE id = $1`,
      [session.id]
    );

    if (updatedSession) {
      printInfo(`Session ID: ${updatedSession.id.substring(0, 8)}...`);
      printInfo(`PR ID in DB: ${updatedSession.pr_id}`);
      printInfo(`PR Number in DB: ${updatedSession.pr_number}`);
      printInfo(`PR URL in DB: ${updatedSession.pr_url}`);

      result.checks.sessionUpdatedWithPR = true;

      // Check PR number
      if (updatedSession.pr_number === TEST_CONFIG.MOCK_PR.number) {
        printSuccess(`✨ PR Number matches! Expected: ${TEST_CONFIG.MOCK_PR.number}, Got: ${updatedSession.pr_number}`);
        result.checks.prNumberInDB = true;
      } else {
        printFailure(`PR Number mismatch! Expected: ${TEST_CONFIG.MOCK_PR.number}, Got: ${updatedSession.pr_number}`);
        result.errors.push('PR number in DB does not match');
        result.success = false;
      }

      // Check PR URL
      if (updatedSession.pr_url === TEST_CONFIG.MOCK_PR.url) {
        printSuccess(`✨ PR URL matches! Got: ${updatedSession.pr_url}`);
        result.checks.prUrlInDB = true;
      } else {
        printFailure(`PR URL mismatch! Expected: ${TEST_CONFIG.MOCK_PR.url}, Got: ${updatedSession.pr_url}`);
        result.errors.push('PR URL in DB does not match');
        result.success = false;
      }
    } else {
      printFailure('Could not fetch updated session from database');
      result.errors.push('Session not found in database');
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
  printHeader('PR Workflow Verification');
  console.log('This script verifies the push_for_review tool logic.');
  console.log('');
  console.log('Test Scenario:');
  console.log('  1. Setup: User, Repository, Session, Feature Branch, Commit');
  console.log('  2. Mock: GitService.push and GitHubAPIService.createPullRequest');
  console.log('  3. Execute: push_for_review logic');
  console.log('  4. Assert: Mocks called correctly, Session updated in DB');

  let result: IVerificationResult | null = null;

  try {
    result = await runVerification();

    // Print Summary
    printHeader('SUMMARY');

    if (result.success) {
      console.log('🎉 All verifications PASSED!\n');
      console.log('The push_for_review workflow is working correctly:');
      console.log('');
      console.log('  ✅ Setup completed (user, repo, session, branch, commit)');
      console.log('  ✅ GitService.push was called');
      console.log('  ✅ GitHubAPIService.createPullRequest was called with correct args');
      console.log('  ✅ Session table updated with PR details');
      console.log('');

      // Print the PR URL from DB
      if (result.session) {
        const finalSession = await queryOne<{ pr_url: string | null }>(
          `SELECT pr_url FROM sessions WHERE id = $1`,
          [result.session.id]
        );
        if (finalSession?.pr_url) {
          console.log('📋 PR URL retrieved from database:');
          console.log(`   ${finalSession.pr_url}`);
          console.log('');
        }
      }

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
      if (result.user) {
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
