#!/usr/bin/env node
/**
 * Authentication Service Test Script
 *
 * This script allows manual testing of the GitHub OAuth flow locally.
 *
 * Usage:
 *   1. Run: npm run build && node dist/test-auth.js
 *   2. Click the OAuth URL printed to console
 *   3. Authorize with GitHub
 *   4. Copy the 'code' parameter from the redirect URL
 *   5. Paste it when prompted
 *
 * Prerequisites:
 *   - PostgreSQL running with migrations applied
 *   - .env file with GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET set
 *   - Create a GitHub OAuth App at https://github.com/settings/developers
 *     with callback URL: http://localhost:3000/oauth/callback
 */

import * as readline from 'readline';
import { authService } from './services/AuthService.js';
import { initializeDatabase, closePool } from './db/client.js';

/**
 * Read a line from stdin
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Parse the authorization code from a callback URL
 */
function parseCodeFromUrl(input: string): { code: string; state: string } | null {
  // If user pasted the full URL, extract code and state
  if (input.startsWith('http')) {
    try {
      const url = new URL(input);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (code && state) {
        return { code, state };
      }
    } catch {
      // Not a valid URL, treat as raw code
    }
  }
  return null;
}

/**
 * Main test function
 */
async function main(): Promise<void> {
  console.log('\n🔐 GitFlow for PMs - Authentication Service Test\n');
  console.log('='.repeat(60));

  try {
    // Initialize database connection
    console.log('\n📦 Initializing database connection...');
    await initializeDatabase();
    console.log('✅ Database connected\n');

    // Step 1: Initiate OAuth flow
    console.log('Step 1: Initiating OAuth flow...\n');
    const oauthResult = authService.initiateOAuth();

    console.log('🔗 GitHub OAuth URL (click or copy to browser):');
    console.log('\n' + '-'.repeat(60));
    console.log(oauthResult.oauthUrl);
    console.log('-'.repeat(60) + '\n');

    console.log(`📋 State token: ${oauthResult.state.substring(0, 16)}...`);
    console.log(`⏱️  Expires in: ${oauthResult.expiresIn} seconds\n`);

    // Step 2: Wait for user to authenticate and paste callback
    console.log('Step 2: Authenticate with GitHub');
    console.log('   1. Click the URL above (or copy to browser)');
    console.log('   2. Authorize the application');
    console.log('   3. You will be redirected to localhost (which may show an error)');
    console.log('   4. Copy the FULL URL from your browser address bar\n');

    const input = await prompt('📥 Paste the callback URL here: ');

    if (!input) {
      console.log('\n❌ No input provided. Exiting.\n');
      return;
    }

    // Parse the input
    let code: string;
    let state: string;

    const parsed = parseCodeFromUrl(input);
    if (parsed) {
      code = parsed.code;
      state = parsed.state;
      console.log(`\n✅ Parsed from URL:`);
      console.log(`   Code: ${code.substring(0, 10)}...`);
      console.log(`   State: ${state.substring(0, 16)}...`);
    } else {
      // User pasted just the code
      code = input;
      state = oauthResult.state;
      console.log(`\n📝 Using provided code with original state token`);
    }

    // Step 3: Handle OAuth callback
    console.log('\nStep 3: Exchanging code for access token...\n');

    const callbackResult = await authService.handleOAuthCallback(code, state);

    console.log('='.repeat(60));
    console.log('🎉 Authentication Successful!');
    console.log('='.repeat(60));
    console.log('\n📋 User Details:');
    console.log(`   ID:       ${callbackResult.user.id}`);
    console.log(`   GitHub:   @${callbackResult.user.githubUsername}`);
    console.log(`   Email:    ${callbackResult.user.email}`);
    console.log(`   Tier:     ${callbackResult.user.tier}`);
    console.log(`   New User: ${callbackResult.isNewUser ? 'Yes' : 'No'}`);
    console.log('\n🔑 Session Token (JWT):');
    console.log(`   ${callbackResult.sessionToken.substring(0, 50)}...`);

    // Step 4: Verify the session token
    console.log('\nStep 4: Verifying session token...');
    const payload = authService.verifySessionToken(callbackResult.sessionToken);
    if (payload) {
      console.log('✅ Session token is valid');
      console.log(`   Subject: ${payload.sub}`);
      console.log(`   GitHub ID: ${payload.githubId}`);
      console.log(`   Expires: ${payload.exp ? new Date(payload.exp * 1000).toISOString() : 'N/A'}`);
    } else {
      console.log('❌ Session token verification failed');
    }

    // Step 5: Test getAccessToken
    console.log('\nStep 5: Retrieving stored access token...');
    const accessToken = await authService.getAccessToken(callbackResult.user.id);
    if (accessToken) {
      console.log(`✅ Access token retrieved successfully (${accessToken.length} chars)`);
      // SECURITY: Don't log the actual token
    } else {
      console.log('⚠️  No access token found (keychain may not be available)');
    }

    // Step 6: Test getUserFromSession
    console.log('\nStep 6: Getting user from session token...');
    const sessionUser = await authService.getUserFromSession(callbackResult.sessionToken);
    if (sessionUser) {
      console.log(`✅ User retrieved: @${sessionUser.githubUsername}`);
    } else {
      console.log('❌ Could not retrieve user from session');
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ All authentication tests passed!');
    console.log('='.repeat(60) + '\n');

    // Optional: Test logout
    const shouldLogout = await prompt('🚪 Test logout? (y/N): ');
    if (shouldLogout.toLowerCase() === 'y') {
      console.log('\nLogging out...');
      await authService.logout(callbackResult.user.id);
      console.log('✅ User logged out successfully');

      // Verify token was removed
      const tokenAfterLogout = await authService.getAccessToken(callbackResult.user.id);
      if (!tokenAfterLogout || tokenAfterLogout === 'LOGGED_OUT') {
        console.log('✅ Access token removed from storage');
      } else {
        console.log('⚠️  Token may still exist in storage');
      }
    }

  } catch (error) {
    console.error('\n❌ Error during authentication test:');
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
      if (error.stack) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    authService.stopCleanup();
    await closePool();
    console.log('✅ Done\n');
  }
}

// Run the test
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
