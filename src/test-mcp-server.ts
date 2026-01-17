/**
 * MCP Server Test Script
 *
 * This script simulates an MCP client to test the GitFlow MCP server.
 * It spawns the server process, connects to it, and tests the auth tools.
 *
 * Usage:
 *   npm run build && node dist/test-mcp-server.js
 *
 * Tests:
 * 1. Lists all available tools and verifies authenticate_github is registered
 * 2. Calls the authenticate_github tool and verifies the response
 */

import { spawn, type ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Test result interface
 */
interface ITestResult {
  name: string;
  passed: boolean;
  message: string;
  details?: unknown;
}

/**
 * Run all MCP server tests
 */
async function runTests(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           GitFlow MCP Server Integration Tests               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  const results: ITestResult[] = [];
  let serverProcess: ChildProcess | null = null;
  let client: Client | null = null;

  try {
    // Spawn the MCP server process
    console.log('📦 Starting MCP server process...');
    serverProcess = spawn('node', ['dist/index.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Ensure we're not in production mode for testing
        NODE_ENV: 'test',
      },
    });

    // Log server stderr output (for debugging)
    serverProcess.stderr?.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message) {
        console.log(`   [server] ${message}`);
      }
    });

    // Handle server process errors
    serverProcess.on('error', (error) => {
      console.error('❌ Server process error:', error.message);
    });

    // Wait a moment for the server to initialize
    await sleep(1000);

    // Create the MCP client transport
    console.log('🔌 Creating MCP client transport...');

    // Filter out undefined env values for type safety
    const filteredEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        filteredEnv[key] = value;
      }
    }
    filteredEnv['NODE_ENV'] = 'test';

    const transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      cwd: process.cwd(),
      env: filteredEnv,
    });

    // Create the MCP client
    console.log('🔗 Creating MCP client...');
    client = new Client(
      {
        name: 'gitflow-test-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    // Connect the client to the server
    console.log('🚀 Connecting to MCP server...');
    await client.connect(transport);
    console.log('✅ Connected successfully!\n');

    // ═══════════════════════════════════════════════════════════════════
    // TEST 1: List Tools
    // ═══════════════════════════════════════════════════════════════════
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TEST 1: List Tools');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const toolsResponse = await client.listTools();
      const tools = toolsResponse.tools;

      console.log(`   Found ${tools.length} tool(s):`);
      tools.forEach((tool) => {
        console.log(`   - ${tool.name}: ${tool.description?.substring(0, 60)}...`);
      });
      console.log();

      // Verify authenticate_github is registered
      const authTool = tools.find((t) => t.name === 'authenticate_github');
      const checkAuthTool = tools.find((t) => t.name === 'check_auth_status');
      const logoutTool = tools.find((t) => t.name === 'logout');

      if (authTool && checkAuthTool && logoutTool) {
        results.push({
          name: 'List Tools',
          passed: true,
          message: 'All 3 auth tools are registered',
          details: {
            toolCount: tools.length,
            tools: tools.map((t) => t.name),
          },
        });
        console.log('   ✅ PASSED: All auth tools are registered\n');
      } else {
        const missing = [];
        if (!authTool) missing.push('authenticate_github');
        if (!checkAuthTool) missing.push('check_auth_status');
        if (!logoutTool) missing.push('logout');

        results.push({
          name: 'List Tools',
          passed: false,
          message: `Missing tools: ${missing.join(', ')}`,
          details: { tools: tools.map((t) => t.name), missing },
        });
        console.log(`   ❌ FAILED: Missing tools: ${missing.join(', ')}\n`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        name: 'List Tools',
        passed: false,
        message: `Error listing tools: ${errorMessage}`,
      });
      console.log(`   ❌ FAILED: ${errorMessage}\n`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST 2: Call authenticate_github Tool
    // ═══════════════════════════════════════════════════════════════════
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TEST 2: Call authenticate_github Tool');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const toolResponse = await client.callTool({
        name: 'authenticate_github',
        arguments: {},
      });

      console.log('   Tool Response:');
      console.log('   ─────────────');

      // The response should have content array
      if (toolResponse.content && Array.isArray(toolResponse.content)) {
        for (const item of toolResponse.content) {
          if (item.type === 'text') {
            // Print each line with indentation
            const lines = (item.text as string).split('\n');
            for (const line of lines) {
              console.log(`   ${line}`);
            }
          }
        }
        console.log();

        // Verify the response contains expected content
        const textContent = toolResponse.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');

        const hasOAuthUrl = textContent.includes('github.com/login/oauth');
        const hasInstructions = textContent.includes('Click this link');

        if (hasOAuthUrl && hasInstructions) {
          results.push({
            name: 'Call authenticate_github',
            passed: true,
            message: 'Tool returned valid OAuth URL and instructions',
            details: { responseLength: textContent.length },
          });
          console.log('   ✅ PASSED: Got valid OAuth response with URL and instructions\n');
        } else {
          results.push({
            name: 'Call authenticate_github',
            passed: false,
            message: 'Response missing OAuth URL or instructions',
            details: { hasOAuthUrl, hasInstructions },
          });
          console.log('   ❌ FAILED: Response missing expected content\n');
        }
      } else {
        results.push({
          name: 'Call authenticate_github',
          passed: false,
          message: 'Invalid response format - no content array',
          details: toolResponse,
        });
        console.log('   ❌ FAILED: Invalid response format\n');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        name: 'Call authenticate_github',
        passed: false,
        message: `Error calling tool: ${errorMessage}`,
      });
      console.log(`   ❌ FAILED: ${errorMessage}\n`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST 3: Call check_auth_status Tool (with non-existent user)
    // ═══════════════════════════════════════════════════════════════════
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TEST 3: Call check_auth_status Tool (anonymous user)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      // Use a random UUID that doesn't exist
      const fakeUserId = '00000000-0000-0000-0000-000000000000';

      const toolResponse = await client.callTool({
        name: 'check_auth_status',
        arguments: { userId: fakeUserId },
      });

      console.log('   Tool Response:');
      console.log('   ─────────────');

      if (toolResponse.content && Array.isArray(toolResponse.content)) {
        for (const item of toolResponse.content) {
          if (item.type === 'text') {
            const lines = (item.text as string).split('\n');
            for (const line of lines) {
              console.log(`   ${line}`);
            }
          }
        }
        console.log();

        const textContent = toolResponse.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');

        // Should indicate not authenticated
        const isNotAuthenticated =
          textContent.includes('anonymous') || textContent.includes('Not Authenticated');

        if (isNotAuthenticated) {
          results.push({
            name: 'Call check_auth_status (anonymous)',
            passed: true,
            message: 'Tool correctly reports user as not authenticated',
          });
          console.log('   ✅ PASSED: Correctly reports anonymous status\n');
        } else {
          results.push({
            name: 'Call check_auth_status (anonymous)',
            passed: false,
            message: 'Expected anonymous status but got different response',
            details: { textContent },
          });
          console.log('   ❌ FAILED: Unexpected response\n');
        }
      } else {
        results.push({
          name: 'Call check_auth_status (anonymous)',
          passed: false,
          message: 'Invalid response format',
        });
        console.log('   ❌ FAILED: Invalid response format\n');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        name: 'Call check_auth_status (anonymous)',
        passed: false,
        message: `Error calling tool: ${errorMessage}`,
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
    // Clean up
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Cleaning up...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (client) {
      try {
        await client.close();
        console.log('   ✓ Client connection closed');
      } catch {
        console.log('   ⚠ Error closing client connection');
      }
    }

    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      console.log('   ✓ Server process terminated');
    }
  }

  // Print summary
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

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run the tests
runTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
