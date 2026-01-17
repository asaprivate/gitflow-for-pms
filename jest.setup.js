/**
 * Jest Setup File
 *
 * This file runs before each test file.
 * Use it to configure the test environment.
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Increase timeout for slow tests
jest.setTimeout(10000);

// Global test utilities can be added here
