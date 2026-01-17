/**
 * Test Script for ErrorTranslator Service
 *
 * This script tests the ErrorTranslator with various mock error scenarios
 * to verify that errors are correctly translated to user-friendly messages.
 *
 * Run with: npx ts-node src/test-error-translator.ts
 * Or: npm run build && node dist/test-error-translator.js
 */

import {
  ErrorTranslator,
  translateError,
  isPushProtectionError,
  requiresReAuthentication,
  type ITranslatedError,
} from './services/ErrorTranslator.js';

// ============================================================================
// Test Cases
// ============================================================================

interface ITestCase {
  readonly name: string;
  readonly description: string;
  readonly error: unknown;
  readonly expectedCategory?: string;
  readonly expectedSeverity?: string;
}

/**
 * Mock error test cases covering various scenarios
 */
const TEST_CASES: readonly ITestCase[] = [
  // ========== Push Protection / Secret Errors ==========
  {
    name: 'GH009 Secret Detection',
    description: 'GitHub Push Protection detected a secret in the code',
    error: `remote: error: GH009: Secrets detected!
remote: Push cannot contain secrets.
remote: 
remote: GITHUB PUSH PROTECTION
remote: ——————————————————————————————————————————
remote: — Secret: Generic API Key
remote: — File: src/config.ts:42
remote: ——————————————————————————————————————————
remote: 
To https://github.com/wix/wix-checkout.git
 ! [remote rejected] feature/add-stripe -> feature/add-stripe (push declined due to secret detection)`,
    expectedCategory: 'push_protection',
    expectedSeverity: 'critical',
  },
  {
    name: 'GH013 Repository Rule Violation',
    description: 'GitHub blocked push due to repository rules',
    error: `remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: 
remote: - GITHUB PUSH PROTECTION
remote:   Commit 1234abc contains a secret
remote: 
To https://github.com/org/repo.git
 ! [remote rejected] main -> main (push declined due to repository rule violations)`,
    expectedCategory: 'push_protection',
    expectedSeverity: 'critical',
  },

  // ========== Merge Conflict Errors ==========
  {
    name: 'Merge Conflict - Single File',
    description: 'Merge conflict in a single file',
    error: `Auto-merging README.md
CONFLICT (content): Merge conflict in README.md
Automatic merge failed; fix conflicts and then commit the result.`,
    expectedCategory: 'merge_conflict',
    expectedSeverity: 'error',
  },
  {
    name: 'Merge Conflict - Multiple Files',
    description: 'Merge conflicts in multiple files',
    error: `Auto-merging src/index.ts
CONFLICT (content): Merge conflict in src/index.ts
Auto-merging src/utils/helpers.ts
CONFLICT (content): Merge conflict in src/utils/helpers.ts
Auto-merging package.json
CONFLICT (content): Merge conflict in package.json
Auto-merging README.md
CONFLICT (content): Merge conflict in README.md
Automatic merge failed; fix conflicts and then commit the result.`,
    expectedCategory: 'merge_conflict',
    expectedSeverity: 'error',
  },
  {
    name: 'Local Changes Would Be Overwritten',
    description: 'Uncommitted changes would be lost',
    error: `error: Your local changes to the following files would be overwritten by merge:
        src/components/Button.tsx
Please commit your changes or stash them before you merge.
Aborting`,
    expectedCategory: 'merge_conflict',
    expectedSeverity: 'warning',
  },

  // ========== Authentication Errors (Octokit-style) ==========
  {
    name: 'Octokit 401 Bad Credentials',
    description: 'GitHub API authentication failed',
    error: {
      status: 401,
      response: {
        status: 401,
        data: {
          message: 'Bad credentials',
          documentation_url: 'https://docs.github.com/rest',
        },
      },
      message: 'Bad credentials',
      name: 'HttpError',
    },
    expectedCategory: 'authentication',
    expectedSeverity: 'error',
  },
  {
    name: 'Git CLI Auth Failed',
    description: 'Git CLI authentication failure',
    error: `fatal: Authentication failed for 'https://github.com/org/repo.git/'`,
    expectedCategory: 'authentication',
    expectedSeverity: 'error',
  },

  // ========== Authorization Errors ==========
  {
    name: 'Octokit 403 Forbidden',
    description: 'User lacks permission to perform action',
    error: {
      status: 403,
      response: {
        status: 403,
        data: {
          message: 'Resource not accessible by integration',
          documentation_url: 'https://docs.github.com/rest',
        },
      },
      message: 'Resource not accessible by integration',
      name: 'HttpError',
    },
    expectedCategory: 'authorization',
    expectedSeverity: 'error',
  },
  {
    name: 'Permission Denied',
    description: 'Git permission denied error',
    error: `fatal: unable to access 'https://github.com/org/private-repo.git/': The requested URL returned error: 403`,
    expectedCategory: 'authorization',
    expectedSeverity: 'error',
  },

  // ========== Network Errors ==========
  {
    name: 'Network Unreachable',
    description: 'Cannot connect to GitHub',
    error: `fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host: github.com`,
    expectedCategory: 'network',
    expectedSeverity: 'error',
  },
  {
    name: 'Connection Timeout',
    description: 'Connection timed out',
    error: `fatal: unable to access 'https://github.com/org/repo.git/': Connection timed out after 30001 milliseconds`,
    expectedCategory: 'network',
    expectedSeverity: 'warning',
  },
  {
    name: 'Fetch Failed (Generic)',
    description: 'Generic network fetch failure',
    error: new Error('fetch failed: network error'),
    expectedCategory: 'unknown', // Falls back to generic
    expectedSeverity: 'error',
  },

  // ========== Push Errors ==========
  {
    name: 'Non-Fast-Forward Push',
    description: 'Branch is behind remote',
    error: `To https://github.com/org/repo.git
 ! [rejected]        feature/my-branch -> feature/my-branch (non-fast-forward)
error: failed to push some refs to 'https://github.com/org/repo.git'
hint: Updates were rejected because the tip of your current branch is behind
hint: its remote counterpart. Integrate the remote changes (e.g.
hint: 'git pull ...') before pushing again.`,
    expectedCategory: 'git_operation',
    expectedSeverity: 'warning',
  },
  {
    name: 'Push Rejected with Commit Count',
    description: 'Branch is 5 commits behind',
    error: `Your branch is 5 commits behind 'origin/main'.
error: failed to push some refs to 'origin'`,
    expectedCategory: 'git_operation',
    expectedSeverity: 'warning',
  },

  // ========== Repository State Errors ==========
  {
    name: 'Not a Git Repository',
    description: 'Directory is not a git repo',
    error: `fatal: not a git repository (or any of the parent directories): .git`,
    expectedCategory: 'git_operation',
    expectedSeverity: 'error',
  },
  {
    name: 'Branch Does Not Exist',
    description: 'Trying to checkout non-existent branch',
    error: `error: pathspec 'feature/nonexistent' did not match any file(s) known to git`,
    expectedCategory: 'git_operation',
    expectedSeverity: 'error',
  },
  {
    name: 'Branch Already Exists',
    description: 'Trying to create existing branch',
    error: `fatal: A branch named 'feature/existing' already exists.`,
    expectedCategory: 'git_operation',
    expectedSeverity: 'warning',
  },

  // ========== Rate Limiting ==========
  {
    name: 'Octokit 429 Rate Limited',
    description: 'GitHub API rate limit exceeded',
    error: {
      status: 429,
      response: {
        status: 429,
        data: {
          message: 'API rate limit exceeded',
          documentation_url: 'https://docs.github.com/rest/rate-limit',
        },
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1642000000',
        },
      },
      message: 'API rate limit exceeded',
      name: 'HttpError',
    },
    expectedCategory: 'rate_limit',
    expectedSeverity: 'warning',
  },
  {
    name: 'Secondary Rate Limit',
    description: 'GitHub secondary rate limit triggered',
    error: {
      status: 403,
      response: {
        status: 403,
        data: {
          message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        },
      },
      message: 'You have exceeded a secondary rate limit',
      name: 'HttpError',
    },
    expectedCategory: 'rate_limit',
    expectedSeverity: 'error',
  },

  // ========== Not Found Errors ==========
  {
    name: 'Octokit 404 Not Found',
    description: 'Repository or resource not found',
    error: {
      status: 404,
      response: {
        status: 404,
        data: {
          message: 'Not Found',
          documentation_url: 'https://docs.github.com/rest',
        },
      },
      message: 'Not Found',
      name: 'HttpError',
    },
    expectedCategory: 'not_found',
    expectedSeverity: 'error',
  },

  // ========== Clean/Info States ==========
  {
    name: 'Nothing to Commit',
    description: 'Working directory is clean',
    error: `On branch main
nothing to commit, working tree clean`,
    expectedCategory: 'git_operation',
    expectedSeverity: 'info',
  },
  {
    name: 'Already Up to Date',
    description: 'Already synced with remote',
    error: `Already up to date.`,
    expectedCategory: 'git_operation',
    expectedSeverity: 'info',
  },

  // ========== Unknown/Generic Error ==========
  {
    name: 'Unknown Error',
    description: 'An unrecognized error that falls back to generic message',
    error: 'Some completely unknown error that does not match any pattern xyz123',
    expectedCategory: 'unknown',
    expectedSeverity: 'error',
  },
];

// ============================================================================
// Test Runner
// ============================================================================

/**
 * Format suggested actions for display
 */
function formatActions(actions: ITranslatedError['suggestedActions']): string {
  if (actions.length === 0) {
    return '  (no actions)';
  }
  return actions.map((a) => `  • [${a.id}] ${a.label}`).join('\n');
}

/**
 * Run a single test case
 */
function runTest(testCase: ITestCase, index: number): boolean {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`TEST ${index + 1}: ${testCase.name}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`Description: ${testCase.description}`);
  console.log(`${'─'.repeat(70)}`);

  // Translate the error
  const result = translateError(testCase.error);

  // Display results
  console.log(`\n📋 RESULT:`);
  console.log(`  Category: ${result.category}`);
  console.log(`  Severity: ${result.severity}`);
  console.log(`  Code: ${result.code ?? '(none)'}`);

  console.log(`\n💬 USER MESSAGE:`);
  console.log(`  "${result.userMessage}"`);

  console.log(`\n🔧 SUGGESTED ACTIONS:`);
  console.log(formatActions(result.suggestedActions));

  if (result.affectedFiles && result.affectedFiles.length > 0) {
    console.log(`\n📁 AFFECTED FILES:`);
    result.affectedFiles.forEach((f) => console.log(`  • ${f}`));
  }

  // Validate expectations
  let passed = true;
  const failures: string[] = [];

  if (testCase.expectedCategory && result.category !== testCase.expectedCategory) {
    passed = false;
    failures.push(`Expected category '${testCase.expectedCategory}', got '${result.category}'`);
  }

  if (testCase.expectedSeverity && result.severity !== testCase.expectedSeverity) {
    passed = false;
    failures.push(`Expected severity '${testCase.expectedSeverity}', got '${result.severity}'`);
  }

  // Check that we have a meaningful user message
  if (!result.userMessage || result.userMessage.length < 10) {
    passed = false;
    failures.push('User message is too short or empty');
  }

  // Display pass/fail status
  console.log(`\n${passed ? '✅ PASS' : '❌ FAIL'}`);
  if (!passed) {
    failures.forEach((f) => console.log(`  ⚠️  ${f}`));
  }

  return passed;
}

/**
 * Run additional helper function tests
 */
function runHelperTests(): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('HELPER FUNCTION TESTS');
  console.log(`${'═'.repeat(70)}`);

  // Test isPushProtectionError
  console.log('\n📌 isPushProtectionError():');
  const secretError = 'remote: error: GH009: Secrets detected in src/config.ts';
  const normalError = 'fatal: not a git repository';
  console.log(`  Secret error → ${isPushProtectionError(secretError)} (expected: true)`);
  console.log(`  Normal error → ${isPushProtectionError(normalError)} (expected: false)`);

  // Test requiresReAuthentication
  console.log('\n📌 requiresReAuthentication():');
  const authError = { status: 401, message: 'Bad credentials' };
  const networkError = 'Could not resolve host: github.com';
  console.log(`  401 error → ${requiresReAuthentication(authError)} (expected: true)`);
  console.log(`  Network error → ${requiresReAuthentication(networkError)} (expected: false)`);

  // Test static methods
  console.log('\n📌 ErrorTranslator.translateMergeConflict():');
  const conflictResult = ErrorTranslator.translateMergeConflict([
    'src/index.ts',
    'package.json',
    'README.md',
  ]);
  console.log(`  User message: "${conflictResult.userMessage}"`);
  console.log(`  Affected files: ${conflictResult.affectedFiles?.join(', ')}`);

  console.log('\n📌 ErrorTranslator.translatePushProtection():');
  const pushProtResult = ErrorTranslator.translatePushProtection(
    ['src/config.ts'],
    'AWS Access Key'
  );
  console.log(`  User message: "${pushProtResult.userMessage}"`);
  console.log(`  Code: ${pushProtResult.code}`);

  console.log('\n📌 ErrorTranslator.isRecoverable():');
  const authTranslated = translateError({ status: 401, message: 'Bad credentials' });
  const unknownTranslated = translateError('some random error xyz');
  console.log(`  Auth error recoverable: ${ErrorTranslator.isRecoverable(authTranslated)} (expected: true)`);
  console.log(`  Unknown error recoverable: ${ErrorTranslator.isRecoverable(unknownTranslated)} (expected: false)`);
}

/**
 * Main test runner
 */
async function main(): Promise<void> {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║           ERROR TRANSLATOR SERVICE - TEST SUITE                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\nRunning ${TEST_CASES.length} test cases...\n`);

  let passed = 0;
  let failed = 0;

  // Run all test cases
  for (let i = 0; i < TEST_CASES.length; i++) {
    const testCase = TEST_CASES[i];
    if (testCase) {
      const success = runTest(testCase, i);
      if (success) {
        passed++;
      } else {
        failed++;
      }
    }
  }

  // Run helper function tests
  runHelperTests();

  // Summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log('SUMMARY');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Total tests: ${TEST_CASES.length}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Exit with appropriate code
  if (failed > 0) {
    process.exit(1);
  }
}

// Run the tests
main().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
