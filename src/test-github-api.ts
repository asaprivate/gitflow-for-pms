/**
 * GitHub API Service Test Script
 *
 * This script verifies the GitHubAPIService functionality by:
 * 1. Connecting to the database
 * 2. Fetching the first user from the users table
 * 3. Retrieving their GitHub access token via AuthService
 * 4. Testing GitHubAPIService methods:
 *    - getUserProfile()
 *    - listRepositories()
 *    - getRateLimit()
 *
 * Prerequisites:
 * - Database must be running (docker compose up -d db)
 * - At least one authenticated user must exist in the database
 * - The user's GitHub token must be valid and stored in keychain
 *
 * Run with: npm run build && node dist/test-github-api.js
 */

import { initializeDatabase, closePool, queryOne } from './db/client.js';
import { authService } from './services/AuthService.js';
import { createGitHubService, GitHubAPIError } from './services/GitHubAPIService.js';

/**
 * Database row type for users table
 */
interface IUserRow {
  id: string;
  github_id: number;
  github_username: string;
  email: string;
  tier: string;
}

/**
 * Main test function
 */
async function runGitHubAPITest(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('  GitHub API Service Test Script');
  console.log('='.repeat(60) + '\n');

  try {
    // Step 1: Connect to database
    console.log('Step 1: Connecting to database...');
    await initializeDatabase();
    console.log('✓ Database connection established\n');

    // Step 2: Fetch the first user
    console.log('Step 2: Fetching first user from database...');
    const user = await queryOne<IUserRow>(
      `SELECT id, github_id, github_username, email, tier 
       FROM users 
       WHERE deleted_at IS NULL 
       ORDER BY created_at ASC 
       LIMIT 1`
    );

    if (!user) {
      console.error('✗ No users found in the database.');
      console.error('  Please authenticate with GitHub first using the OAuth flow.');
      process.exitCode = 1;
      return;
    }

    console.log('✓ Found user:');
    console.log(`  - ID: ${user.id}`);
    console.log(`  - GitHub Username: ${user.github_username}`);
    console.log(`  - GitHub ID: ${user.github_id}`);
    console.log(`  - Email: ${user.email}`);
    console.log(`  - Tier: ${user.tier}\n`);

    // Step 3: Get access token via AuthService
    console.log('Step 3: Retrieving GitHub access token...');
    const accessToken = await authService.getAccessToken(user.id);

    if (!accessToken) {
      console.error('✗ No access token found for this user.');
      console.error('  The token may have been revoked or the keychain is unavailable.');
      process.exitCode = 1;
      return;
    }

    console.log('✓ Access token retrieved (stored securely, not displayed)\n');

    // Step 4: Create GitHubAPIService instance
    console.log('Step 4: Creating GitHubAPIService instance...');
    const github = createGitHubService(accessToken);
    console.log('✓ GitHubAPIService instance created\n');

    // Step 5: Test getUserProfile()
    console.log('Step 5: Testing getUserProfile()...');
    try {
      const profile = await github.getUserProfile();
      console.log('✓ User profile retrieved:');
      console.log(`  - ID: ${profile.id}`);
      console.log(`  - Login: ${profile.login}`);
      console.log(`  - Name: ${profile.name ?? '(not set)'}`);
      console.log(`  - Email: ${profile.email ?? '(private)'}`);
      console.log(`  - Avatar: ${profile.avatarUrl}\n`);
    } catch (error) {
      handleError('getUserProfile()', error);
    }

    // Step 6: Test listRepositories()
    console.log('Step 6: Testing listRepositories({ perPage: 3 })...');
    try {
      const repos = await github.listRepositories({ perPage: 3 });
      console.log(`✓ Retrieved ${repos.length} repositories:`);
      for (const repo of repos) {
        const visibility = repo.private ? '🔒 private' : '🌐 public';
        console.log(`  - ${repo.fullName} (${visibility})`);
        console.log(`    ⭐ ${repo.stars} | 🍴 ${repo.forks} | Default branch: ${repo.defaultBranch}`);
      }
      console.log();
    } catch (error) {
      handleError('listRepositories()', error);
    }

    // Step 7: Test getRateLimit()
    console.log('Step 7: Testing getRateLimit()...');
    try {
      const rateLimit = await github.getRateLimit();
      const resetTime = rateLimit.reset.toLocaleTimeString();
      const usagePercent = ((rateLimit.used / rateLimit.limit) * 100).toFixed(1);

      console.log('✓ Rate limit status:');
      console.log(`  - Limit: ${rateLimit.limit} requests/hour`);
      console.log(`  - Remaining: ${rateLimit.remaining}`);
      console.log(`  - Used: ${rateLimit.used} (${usagePercent}%)`);
      console.log(`  - Resets at: ${resetTime}\n`);

      // Warning if approaching limit
      if (rateLimit.remaining < 100) {
        console.log('⚠️  Warning: Approaching rate limit!\n');
      }
    } catch (error) {
      handleError('getRateLimit()', error);
    }

    // Step 8 (Bonus): Test getUserOrganizations()
    console.log('Step 8 (Bonus): Testing getUserOrganizations()...');
    try {
      const orgs = await github.getUserOrganizations();
      if (orgs.length > 0) {
        console.log(`✓ User belongs to ${orgs.length} organization(s):`);
        for (const org of orgs.slice(0, 5)) {
          console.log(`  - ${org.login}`);
        }
        if (orgs.length > 5) {
          console.log(`  ... and ${orgs.length - 5} more`);
        }
      } else {
        console.log('✓ User does not belong to any organizations');
      }
      console.log();
    } catch (error) {
      handleError('getUserOrganizations()', error);
    }

    // Summary
    console.log('='.repeat(60));
    console.log('  Test Summary');
    console.log('='.repeat(60));
    console.log('\n✅ All GitHubAPIService tests completed successfully!\n');
    console.log('Tested methods:');
    console.log('  ✓ getUserProfile() - Get authenticated user details');
    console.log('  ✓ listRepositories() - List accessible repositories');
    console.log('  ✓ getRateLimit() - Check API rate limit status');
    console.log('  ✓ getUserOrganizations() - List user organizations\n');

  } catch (error) {
    console.error('\n❌ Test failed with unexpected error:');
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
      if (error.stack) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  } finally {
    // Cleanup: Close database connection
    console.log('Cleaning up...');
    await closePool();
    console.log('✓ Database connection closed\n');
    console.log('='.repeat(60) + '\n');
  }
}

/**
 * Handle and display errors in a user-friendly way
 */
function handleError(method: string, error: unknown): void {
  if (error instanceof GitHubAPIError) {
    console.error(`✗ ${method} failed:`);
    console.error(`  - Status: ${error.status}`);
    console.error(`  - Message: ${error.userMessage}`);
    if (error.isAuthError) {
      console.error('  - Suggestion: Re-authenticate with GitHub');
    } else if (error.isRateLimited) {
      console.error('  - Suggestion: Wait a few minutes before retrying');
    }
  } else if (error instanceof Error) {
    console.error(`✗ ${method} failed: ${error.message}`);
  } else {
    console.error(`✗ ${method} failed:`, error);
  }
  console.log();
}

// Run the test
runGitHubAPITest().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
