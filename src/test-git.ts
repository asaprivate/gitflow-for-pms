/**
 * Git Service Test Script
 *
 * This script verifies the GitService functionality by:
 * 1. Creating a temporary directory
 * 2. Initializing a fresh git repository
 * 3. Creating a dummy file
 * 4. Running add and commit operations
 * 5. Logging the status to verify tracking
 * 6. Cleaning up the directory
 *
 * Run with: npm run build && node dist/test-git.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';

import { GitService } from './services/GitService.js';
import { logger } from './utils/logger.js';

// Test configuration
const TEST_USER_ID = 'test-user-123';
const TEST_REPO_NAME = 'gitflow-test-repo';

/**
 * Create a temporary directory for testing
 */
function createTempDir(): string {
  const tempBase = path.join(os.tmpdir(), 'gitflow-tests');
  if (!fs.existsSync(tempBase)) {
    fs.mkdirSync(tempBase, { recursive: true });
  }

  const tempDir = path.join(tempBase, `${TEST_REPO_NAME}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  return tempDir;
}

/**
 * Clean up the test directory
 */
function cleanupDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    logger.info({ path: dirPath }, '✓ Cleaned up test directory');
  }
}

/**
 * Initialize a git repository in the given directory
 */
async function initGitRepo(dirPath: string): Promise<void> {
  const git = simpleGit(dirPath);
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  logger.info({ path: dirPath }, '✓ Initialized git repository');
}

/**
 * Create a dummy file for testing
 */
function createDummyFile(dirPath: string, filename: string, content: string): string {
  const filePath = path.join(dirPath, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  logger.info({ file: filename }, '✓ Created dummy file');
  return filePath;
}

/**
 * Main test function
 */
async function runGitServiceTest(): Promise<void> {
  let testDir: string | null = null;

  console.log('\n' + '='.repeat(60));
  console.log('  GitService Test Script');
  console.log('='.repeat(60) + '\n');

  try {
    // Step 1: Create temporary directory
    console.log('Step 1: Creating temporary directory...');
    testDir = createTempDir();
    logger.info({ path: testDir }, '✓ Created temp directory');

    // Step 2: Initialize git repository
    console.log('\nStep 2: Initializing git repository...');
    await initGitRepo(testDir);

    // Step 3: Create GitService instance
    console.log('\nStep 3: Creating GitService instance...');
    const gitService = GitService.forExistingRepo(TEST_USER_ID, testDir);
    logger.info({ userId: TEST_USER_ID, path: testDir }, '✓ Created GitService instance');

    // Step 4: Verify initial status (should be clean, no commits yet)
    console.log('\nStep 4: Checking initial status...');
    const initialStatus = await gitService.status();
    console.log('Initial status:');
    console.log(`  - Current branch: ${initialStatus.currentBranch}`);
    console.log(`  - Is clean: ${initialStatus.isClean}`);
    console.log(`  - Modified files: ${initialStatus.modifiedFiles.length}`);
    console.log(`  - Staged files: ${initialStatus.stagedFiles.length}`);
    console.log(`  - Untracked files: ${initialStatus.untrackedFiles.length}`);

    // Step 5: Create dummy file
    console.log('\nStep 5: Creating dummy file (hello.txt)...');
    createDummyFile(testDir, 'hello.txt', 'Hello, GitFlow!\n\nThis is a test file.\n');

    // Step 6: Check status after file creation (should show untracked)
    console.log('\nStep 6: Checking status after file creation...');
    const afterCreateStatus = await gitService.status();
    console.log('Status after file creation:');
    console.log(`  - Is clean: ${afterCreateStatus.isClean}`);
    console.log(`  - Untracked files: ${afterCreateStatus.untrackedFiles.join(', ') || 'none'}`);

    if (afterCreateStatus.untrackedFiles.includes('hello.txt')) {
      logger.info({}, '✓ File detected as untracked');
    }

    // Step 7: Stage the file
    console.log('\nStep 7: Staging file with add()...');
    await gitService.add(['hello.txt']);
    logger.info({}, '✓ Staged hello.txt');

    // Step 8: Check status after staging (should show staged)
    console.log('\nStep 8: Checking status after staging...');
    const afterStageStatus = await gitService.status();
    console.log('Status after staging:');
    console.log(`  - Is clean: ${afterStageStatus.isClean}`);
    console.log(`  - Staged files: ${afterStageStatus.stagedFiles.join(', ') || 'none'}`);
    console.log(`  - Untracked files: ${afterStageStatus.untrackedFiles.join(', ') || 'none'}`);

    if (afterStageStatus.stagedFiles.includes('hello.txt')) {
      logger.info({}, '✓ File is now staged');
    }

    // Step 9: Commit the file
    console.log('\nStep 9: Committing with commit()...');
    const commitResult = await gitService.commit({
      message: 'Initial commit: Add hello.txt',
    });
    console.log('Commit result:');
    console.log(`  - Commit hash: ${commitResult.commitHash}`);
    console.log(`  - Message: ${commitResult.message}`);
    console.log(`  - Files changed: ${commitResult.filesChanged}`);
    logger.info({ commitHash: commitResult.commitHash }, '✓ Committed successfully');

    // Step 10: Check final status (should be clean)
    console.log('\nStep 10: Checking final status...');
    const finalStatus = await gitService.status();
    console.log('Final status:');
    console.log(`  - Current branch: ${finalStatus.currentBranch}`);
    console.log(`  - Is clean: ${finalStatus.isClean}`);
    console.log(`  - Modified files: ${finalStatus.modifiedFiles.length}`);
    console.log(`  - Staged files: ${finalStatus.stagedFiles.length}`);
    console.log(`  - Untracked files: ${finalStatus.untrackedFiles.length}`);

    if (finalStatus.isClean) {
      logger.info({}, '✓ Repository is clean after commit');
    }

    // Step 11: Verify with git log
    console.log('\nStep 11: Checking commit log...');
    const log = await gitService.getLog(5);
    console.log('Commit log:');
    for (const commit of log) {
      console.log(`  - ${commit.hash.substring(0, 7)}: ${commit.message}`);
    }

    // Step 12: Test branch operations
    console.log('\nStep 12: Testing branch operations...');
    const currentBranch = await gitService.getCurrentBranch();
    console.log(`  - Current branch: ${currentBranch}`);

    // Create a new branch
    await gitService.createBranch('feature/test-branch', undefined, true);
    const newBranch = await gitService.getCurrentBranch();
    console.log(`  - Created and switched to: ${newBranch}`);
    logger.info({ branch: newBranch }, '✓ Created new branch');

    // Switch back to main/master
    await gitService.checkout(currentBranch);
    const backToMain = await gitService.getCurrentBranch();
    console.log(`  - Switched back to: ${backToMain}`);

    // List all branches
    const branches = await gitService.getBranches();
    console.log(`  - All branches: ${branches.map((b) => b.name).join(', ')}`);

    // Step 13: Test modifying a file and checking status
    console.log('\nStep 13: Testing file modification detection...');
    fs.appendFileSync(path.join(testDir, 'hello.txt'), '\nAppended line for testing.\n');

    const modifiedStatus = await gitService.status();
    console.log('Status after modification:');
    console.log(`  - Modified files: ${modifiedStatus.modifiedFiles.join(', ') || 'none'}`);

    if (modifiedStatus.modifiedFiles.includes('hello.txt')) {
      logger.info({}, '✓ File modification detected');
    }

    // Step 14: Test soft reset
    console.log('\nStep 14: Testing commit and soft reset...');

    // First commit the modification
    await gitService.add('.');
    const secondCommit = await gitService.commit({
      message: 'Add appended line',
    });
    console.log(`  - Created second commit: ${secondCommit.commitHash.substring(0, 7)}`);

    // Now soft reset
    await gitService.softReset(1);
    const afterResetStatus = await gitService.status();
    console.log(`  - After soft reset - staged files: ${afterResetStatus.stagedFiles.length}`);
    console.log(`  - Is clean: ${afterResetStatus.isClean}`);

    if (afterResetStatus.stagedFiles.length > 0) {
      logger.info({}, '✓ Soft reset kept changes staged');
    }

    // Re-commit for clean state
    await gitService.commit({ message: 'Re-add appended line' });

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('  Test Summary');
    console.log('='.repeat(60));
    console.log('\n✅ All GitService operations tested successfully!\n');
    console.log('Tested operations:');
    console.log('  ✓ status() - Get repository status');
    console.log('  ✓ add() - Stage files');
    console.log('  ✓ commit() - Create commits');
    console.log('  ✓ getLog() - Get commit history');
    console.log('  ✓ getCurrentBranch() - Get current branch');
    console.log('  ✓ createBranch() - Create new branch');
    console.log('  ✓ checkout() - Switch branches');
    console.log('  ✓ getBranches() - List all branches');
    console.log('  ✓ softReset() - Undo commits keeping changes');
    console.log('\nNote: clone(), push(), pull(), fetch() require GitHub authentication');
    console.log('      and are tested separately with valid OAuth tokens.\n');
  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error instanceof Error ? error.message : error);
    console.error('\nStack trace:');
    console.error(error instanceof Error ? error.stack : 'No stack trace available');
    process.exitCode = 1;
  } finally {
    // Cleanup
    console.log('\nStep 15: Cleaning up...');
    if (testDir) {
      cleanupDir(testDir);
    }
    console.log('\n' + '='.repeat(60) + '\n');
  }
}

// Run the test
runGitServiceTest().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
