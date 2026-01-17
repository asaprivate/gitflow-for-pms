/**
 * Git Tools MCP Test Script
 *
 * This script tests the Git operation MCP tools by:
 * 1. Creating a temporary git repository
 * 2. Making commits and modifications
 * 3. Starting the MCP server
 * 4. Calling git_status tool and verifying output
 * 5. Cleaning up the test repository
 *
 * Usage:
 *   npm run build && node dist/test-git-tools.js
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ============================================================================
// Types
// ============================================================================

interface ITestResult {
  name: string;
  passed: boolean;
  message: string;
  details?: unknown;
}

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temporary directory for testing
 */
function createTempDir(): string {
  const tempBase = path.join(os.tmpdir(), 'gitflow-test');
  const tempDir = path.join(tempBase, `test-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Clean up a directory
 */
function cleanupDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * Run a git command in a directory
 */
function runGit(cwd: string, ...args: string[]): string {
  try {
    return execSync(`git ${args.join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const execError = error as { stderr?: Buffer; stdout?: Buffer };
    throw new Error(
      `Git command failed: git ${args.join(' ')}\n${execError.stderr?.toString() ?? ''}`
    );
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create filtered environment for subprocess
 */
function createFilteredEnv(): Record<string, string> {
  const filteredEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      filteredEnv[key] = value;
    }
  }
  filteredEnv['NODE_ENV'] = 'test';
  return filteredEnv;
}

// ============================================================================
// Test Setup
// ============================================================================

/**
 * Set up a test git repository with some history
 */
function setupTestRepo(repoPath: string): void {
  console.log('📁 Setting up test repository...');

  // Initialize git repo
  runGit(repoPath, 'init');
  console.log('   ✓ Git initialized');

  // Configure git user (required for commits)
  runGit(repoPath, 'config', 'user.name', '"Test User"');
  runGit(repoPath, 'config', 'user.email', '"test@example.com"');
  console.log('   ✓ Git user configured');

  // Create initial file
  const testFile = path.join(repoPath, 'README.md');
  fs.writeFileSync(testFile, '# Test Repository\n\nThis is a test file.\n');
  console.log('   ✓ Created README.md');

  // Create another file
  const codeFile = path.join(repoPath, 'index.js');
  fs.writeFileSync(codeFile, 'console.log("Hello, World!");\n');
  console.log('   ✓ Created index.js');

  // Stage and commit
  runGit(repoPath, 'add', '.');
  runGit(repoPath, 'commit', '-m', '"Initial commit"');
  console.log('   ✓ Created initial commit');

  // Add another commit
  fs.appendFileSync(testFile, '\n## Getting Started\n\nRun `npm install` to get started.\n');
  runGit(repoPath, 'add', '.');
  runGit(repoPath, 'commit', '-m', '"Add getting started section"');
  console.log('   ✓ Created second commit');

  // Modify files to make the repo "dirty"
  fs.appendFileSync(testFile, '\n## Contributing\n\nPRs welcome!\n');
  fs.writeFileSync(codeFile, 'console.log("Hello, GitFlow!");\nconsole.log("Modified!");\n');
  console.log('   ✓ Modified files (repo is now dirty)');

  // Create an untracked file
  const newFile = path.join(repoPath, 'new-feature.ts');
  fs.writeFileSync(newFile, 'export function newFeature() {\n  return "new";\n}\n');
  console.log('   ✓ Created untracked file');

  console.log('');
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runTests(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           GitFlow Git Tools Integration Tests                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  const results: ITestResult[] = [];
  let testRepoPath: string | null = null;
  let client: Client | null = null;

  // Use a fake UUID for testing (must be RFC 4122 compliant - variant byte 8/9/a/b)
  // Format: xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx where M is version (1-5) and N is variant (8,9,a,b)
  const testUserId = '11111111-1111-4111-a111-111111111111';

  try {
    // =========================================================================
    // Setup Phase
    // =========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('SETUP: Creating Test Repository');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    testRepoPath = createTempDir();
    console.log(`   Test repo path: ${testRepoPath}`);
    console.log('');

    setupTestRepo(testRepoPath);

    // Verify setup
    const gitStatus = runGit(testRepoPath, 'status', '--porcelain');
    console.log('   Git status (porcelain):');
    for (const line of gitStatus.split('\n')) {
      if (line.trim()) {
        console.log(`     ${line}`);
      }
    }
    console.log('');

    // =========================================================================
    // Start MCP Server
    // =========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('SETUP: Starting MCP Server');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    console.log('🔌 Creating MCP client transport...');
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      cwd: process.cwd(),
      env: createFilteredEnv(),
    });

    console.log('🔗 Creating MCP client...');
    client = new Client(
      {
        name: 'git-tools-test-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    console.log('🚀 Connecting to MCP server...');
    await client.connect(transport);
    console.log('✅ Connected successfully!\n');

    // Wait for server to be ready
    await sleep(500);

    // =========================================================================
    // TEST 1: List Tools (verify git_status is available)
    // =========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TEST 1: Verify git_status Tool is Registered');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const toolsResponse = await client.listTools();
      const gitStatusTool = toolsResponse.tools.find((t) => t.name === 'git_status');

      if (gitStatusTool) {
        console.log(`   ✓ Found git_status tool: "${gitStatusTool.description?.substring(0, 60)}..."`);
        results.push({
          name: 'Tool Registration',
          passed: true,
          message: 'git_status tool is registered',
        });
        console.log('   ✅ PASSED\n');
      } else {
        results.push({
          name: 'Tool Registration',
          passed: false,
          message: 'git_status tool not found',
        });
        console.log('   ❌ FAILED: git_status not found\n');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        name: 'Tool Registration',
        passed: false,
        message: `Error: ${errorMessage}`,
      });
      console.log(`   ❌ FAILED: ${errorMessage}\n`);
    }

    // =========================================================================
    // TEST 2: Call git_status Tool
    // =========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TEST 2: Call git_status Tool');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      console.log(`   Calling git_status with:`);
      console.log(`     repoPath: ${testRepoPath}`);
      console.log(`     userId: ${testUserId}`);
      console.log('');

      const toolResponse = await client.callTool({
        name: 'git_status',
        arguments: {
          repoPath: testRepoPath,
          userId: testUserId,
        },
      });

      console.log('   Tool Response (Markdown):');
      console.log('   ─────────────────────────');

      let responseText = '';
      if (toolResponse.content && Array.isArray(toolResponse.content)) {
        for (const item of toolResponse.content) {
          if (item.type === 'text') {
            responseText = item.text as string;
            // Print each line with indentation
            for (const line of responseText.split('\n')) {
              console.log(`   ${line}`);
            }
          }
        }
      }
      console.log('');

      // Verify the output contains expected information
      const checks = {
        hasBranchInfo: responseText.includes('Branch:') || responseText.includes('**Branch:**'),
        hasModifiedFiles: responseText.includes('Modified') || responseText.includes('modified'),
        mentionsReadme: responseText.toLowerCase().includes('readme'),
        mentionsIndexJs: responseText.toLowerCase().includes('index.js'),
        hasNewFiles: responseText.includes('New Files') || responseText.includes('untracked'),
      };

      console.log('   Verification Checks:');
      console.log(`     ✓ Has branch info: ${checks.hasBranchInfo ? 'YES' : 'NO'}`);
      console.log(`     ✓ Has modified files: ${checks.hasModifiedFiles ? 'YES' : 'NO'}`);
      console.log(`     ✓ Mentions README: ${checks.mentionsReadme ? 'YES' : 'NO'}`);
      console.log(`     ✓ Mentions index.js: ${checks.mentionsIndexJs ? 'YES' : 'NO'}`);
      console.log(`     ✓ Has new files: ${checks.hasNewFiles ? 'YES' : 'NO'}`);
      console.log('');

      const allChecksPassed =
        checks.hasBranchInfo &&
        checks.hasModifiedFiles &&
        (checks.mentionsReadme || checks.mentionsIndexJs);

      if (allChecksPassed) {
        results.push({
          name: 'git_status Response',
          passed: true,
          message: 'Response contains expected repository status information',
          details: checks,
        });
        console.log('   ✅ PASSED: git_status returned correct information\n');
      } else {
        results.push({
          name: 'git_status Response',
          passed: false,
          message: 'Response missing expected information',
          details: checks,
        });
        console.log('   ❌ FAILED: Response missing expected information\n');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        name: 'git_status Response',
        passed: false,
        message: `Error: ${errorMessage}`,
      });
      console.log(`   ❌ FAILED: ${errorMessage}\n`);
    }

    // =========================================================================
    // TEST 3: Call git_commit Tool (verify commit flow)
    // =========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TEST 3: Call git_commit Tool');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const commitMessage = 'Test commit from MCP tool';
      console.log(`   Calling git_commit with:`);
      console.log(`     repoPath: ${testRepoPath}`);
      console.log(`     message: "${commitMessage}"`);
      console.log(`     userId: ${testUserId}`);
      console.log('');

      const toolResponse = await client.callTool({
        name: 'git_commit',
        arguments: {
          repoPath: testRepoPath,
          message: commitMessage,
          userId: testUserId,
        },
      });

      console.log('   Tool Response:');
      console.log('   ─────────────');

      let responseText = '';
      if (toolResponse.content && Array.isArray(toolResponse.content)) {
        for (const item of toolResponse.content) {
          if (item.type === 'text') {
            responseText = item.text as string;
            for (const line of responseText.split('\n')) {
              console.log(`   ${line}`);
            }
          }
        }
      }
      console.log('');

      // Verify commit was successful
      const commitSuccess =
        responseText.includes('Commit Created') || responseText.includes('✅');
      const hasCommitHash =
        responseText.includes('Commit:') || responseText.includes('commitHash');

      if (commitSuccess && hasCommitHash) {
        results.push({
          name: 'git_commit Response',
          passed: true,
          message: 'Commit was created successfully',
        });
        console.log('   ✅ PASSED: Commit created successfully\n');

        // Verify with actual git log
        const lastCommit = runGit(testRepoPath, 'log', '-1', '--oneline');
        console.log(`   Verified in git log: ${lastCommit}\n`);
      } else {
        results.push({
          name: 'git_commit Response',
          passed: false,
          message: 'Commit may have failed or response unexpected',
          details: { responseText },
        });
        console.log('   ❌ FAILED: Unexpected response\n');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        name: 'git_commit Response',
        passed: false,
        message: `Error: ${errorMessage}`,
      });
      console.log(`   ❌ FAILED: ${errorMessage}\n`);
    }

    // =========================================================================
    // TEST 4: Call git_checkout Tool (create new branch)
    // =========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TEST 4: Call git_checkout Tool (create branch)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const branchName = 'feature/test-branch';
      console.log(`   Calling git_checkout with:`);
      console.log(`     repoPath: ${testRepoPath}`);
      console.log(`     branch: "${branchName}"`);
      console.log(`     create: true`);
      console.log(`     userId: ${testUserId}`);
      console.log('');

      const toolResponse = await client.callTool({
        name: 'git_checkout',
        arguments: {
          repoPath: testRepoPath,
          branch: branchName,
          create: true,
          userId: testUserId,
        },
      });

      console.log('   Tool Response:');
      console.log('   ─────────────');

      let responseText = '';
      if (toolResponse.content && Array.isArray(toolResponse.content)) {
        for (const item of toolResponse.content) {
          if (item.type === 'text') {
            responseText = item.text as string;
            for (const line of responseText.split('\n')) {
              console.log(`   ${line}`);
            }
          }
        }
      }
      console.log('');

      // Verify branch was created
      const branchCreated =
        responseText.includes('Branch Created') || responseText.includes('✅');
      const mentionsBranch = responseText.includes(branchName);

      if (branchCreated && mentionsBranch) {
        results.push({
          name: 'git_checkout Response',
          passed: true,
          message: `Branch "${branchName}" created successfully`,
        });
        console.log('   ✅ PASSED: Branch created successfully\n');

        // Verify with actual git branch
        const currentBranch = runGit(testRepoPath, 'branch', '--show-current');
        console.log(`   Verified current branch: ${currentBranch}\n`);
      } else {
        results.push({
          name: 'git_checkout Response',
          passed: false,
          message: 'Branch creation may have failed',
          details: { responseText },
        });
        console.log('   ❌ FAILED: Unexpected response\n');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        name: 'git_checkout Response',
        passed: false,
        message: `Error: ${errorMessage}`,
      });
      console.log(`   ❌ FAILED: ${errorMessage}\n`);
    }
  } catch (error) {
    console.error('❌ Test execution error:', error);
    results.push({
      name: 'Test Execution',
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // =========================================================================
    // Cleanup Phase
    // =========================================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('CLEANUP');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (client) {
      try {
        await client.close();
        console.log('   ✓ Client connection closed');
      } catch {
        console.log('   ⚠ Error closing client connection');
      }
    }

    if (testRepoPath) {
      try {
        cleanupDir(testRepoPath);
        console.log(`   ✓ Test repository cleaned up: ${testRepoPath}`);
      } catch {
        console.log(`   ⚠ Failed to clean up: ${testRepoPath}`);
      }
    }
  }

  // =========================================================================
  // Print Summary
  // =========================================================================
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                        Test Summary                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    console.log(`${icon} ${result.name}: ${result.message}`);
  }

  console.log();
  console.log(`Total: ${results.length} tests | Passed: ${passed} | Failed: ${failed}`);
  console.log();

  if (failed > 0) {
    console.log('❌ Some tests failed!');
    process.exit(1);
  } else {
    console.log('✅ All tests passed!');
    process.exit(0);
  }
}

// Run the tests
runTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
