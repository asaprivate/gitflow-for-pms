#!/usr/bin/env node
/**
 * Database Migration Runner
 *
 * Executes SQL migration files in order from the migrations directory.
 * Tracks applied migrations in the schema_migrations table.
 *
 * Usage:
 *   npm run migrate              # Run pending migrations
 *   npm run migrate:status       # Show migration status
 *   npm run migrate -- --dry-run # Preview without executing
 */

import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import pg, { type QueryResultRow } from 'pg';

const { Pool } = pg;

// =============================================================================
// Configuration
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, 'migrations');

interface IMigrationRecord extends QueryResultRow {
  version: string;
  applied_at: Date;
  execution_time_ms: number | null;
  checksum: string | null;
}

interface IMigrationFile {
  filename: string;
  version: string;
  path: string;
  content: string;
  checksum: string;
}

// =============================================================================
// Database Connection
// =============================================================================

function createPool(): pg.Pool {
  const connectionString = process.env['DATABASE_URL'];

  if (!connectionString) {
    console.error('❌ DATABASE_URL environment variable is required');
    process.exit(1);
  }

  return new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

// =============================================================================
// Migration Helpers
// =============================================================================

/**
 * Calculate SHA-256 checksum of file content
 */
function calculateChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Get list of migration files sorted by version
 */
async function getMigrationFiles(): Promise<IMigrationFile[]> {
  const files = await readdir(MIGRATIONS_DIR);

  const sqlFiles = files
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Alphabetical sort ensures correct order (000_, 001_, etc.)

  const migrations: IMigrationFile[] = [];

  for (const filename of sqlFiles) {
    const path = join(MIGRATIONS_DIR, filename);
    const content = await readFile(path, 'utf-8');
    const version = filename.replace('.sql', '');
    const checksum = calculateChecksum(content);

    migrations.push({
      filename,
      version,
      path,
      content,
      checksum,
    });
  }

  return migrations;
}

/**
 * Get list of applied migrations from database
 */
async function getAppliedMigrations(pool: pg.Pool): Promise<Map<string, IMigrationRecord>> {
  try {
    const result = await pool.query<IMigrationRecord>(
      'SELECT version, applied_at, execution_time_ms, checksum FROM schema_migrations ORDER BY version'
    );

    const applied = new Map<string, IMigrationRecord>();
    for (const row of result.rows) {
      applied.set(row.version, row);
    }

    return applied;
  } catch (error) {
    // Table doesn't exist yet - this is fine for first migration
    if ((error as { code?: string }).code === '42P01') {
      return new Map();
    }
    throw error;
  }
}

/**
 * Record a migration as applied
 */
async function recordMigration(
  pool: pg.Pool,
  version: string,
  checksum: string,
  executionTimeMs: number
): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations (version, checksum, execution_time_ms)
     VALUES ($1, $2, $3)
     ON CONFLICT (version) DO UPDATE SET
       checksum = $2,
       execution_time_ms = $3,
       applied_at = NOW()`,
    [version, checksum, executionTimeMs]
  );
}

/**
 * Execute a single migration
 */
async function executeMigration(
  pool: pg.Pool,
  migration: IMigrationFile,
  dryRun: boolean
): Promise<{ success: boolean; durationMs: number; error?: Error }> {
  const start = Date.now();

  if (dryRun) {
    console.log(`  📋 [DRY RUN] Would execute: ${migration.filename}`);
    console.log(`     Checksum: ${migration.checksum.substring(0, 16)}...`);
    return { success: true, durationMs: 0 };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(migration.content);
    await client.query('COMMIT');

    const durationMs = Date.now() - start;

    // Record successful migration
    await recordMigration(pool, migration.version, migration.checksum, durationMs);

    return { success: true, durationMs };
  } catch (error) {
    await client.query('ROLLBACK');
    return {
      success: false,
      durationMs: Date.now() - start,
      error: error as Error,
    };
  } finally {
    client.release();
  }
}

// =============================================================================
// CLI Commands
// =============================================================================

/**
 * Run pending migrations
 */
async function runMigrations(dryRun: boolean): Promise<void> {
  console.log('🚀 GitFlow Database Migration Runner\n');

  const pool = createPool();

  try {
    // Get all migration files
    const migrationFiles = await getMigrationFiles();
    console.log(`📁 Found ${migrationFiles.length} migration files\n`);

    // Get already applied migrations
    const appliedMigrations = await getAppliedMigrations(pool);
    console.log(`✅ ${appliedMigrations.size} migrations already applied\n`);

    // Find pending migrations
    const pendingMigrations = migrationFiles.filter(
      (m) => !appliedMigrations.has(m.version)
    );

    if (pendingMigrations.length === 0) {
      console.log('✨ Database is up to date!\n');
      return;
    }

    console.log(`⏳ Running ${pendingMigrations.length} pending migrations...\n`);

    // Check for checksum mismatches (drift detection)
    for (const migration of migrationFiles) {
      const applied = appliedMigrations.get(migration.version);
      if (applied?.checksum !== null && applied?.checksum !== undefined && applied.checksum !== migration.checksum) {
        console.error(`❌ Checksum mismatch for ${migration.version}!`);
        console.error(`   Database: ${applied.checksum.substring(0, 16)}...`);
        console.error(`   File:     ${migration.checksum.substring(0, 16)}...`);
        console.error('\n   Migration file has been modified after being applied.');
        console.error('   This may indicate schema drift.\n');
        process.exit(1);
      }
    }

    // Execute pending migrations
    let successCount = 0;
    let failedMigration: string | null = null;

    for (const migration of pendingMigrations) {
      process.stdout.write(`  📄 ${migration.filename}... `);

      const result = await executeMigration(pool, migration, dryRun);

      if (result.success) {
        successCount++;
        if (!dryRun) {
          console.log(`✅ (${result.durationMs}ms)`);
        }
      } else {
        console.log(`❌ FAILED`);
        console.error(`\n     Error: ${result.error?.message}\n`);
        failedMigration = migration.filename;
        break; // Stop on first failure
      }
    }

    console.log('');

    if (failedMigration !== null) {
      console.error(`❌ Migration failed: ${failedMigration}`);
      console.error(`   ${successCount}/${pendingMigrations.length} migrations completed before failure.\n`);
      process.exit(1);
    }

    if (dryRun) {
      console.log(`📋 Dry run complete. ${successCount} migrations would be applied.\n`);
    } else {
      console.log(`✨ Successfully applied ${successCount} migrations!\n`);
    }
  } finally {
    await pool.end();
  }
}

/**
 * Show migration status
 */
async function showStatus(): Promise<void> {
  console.log('📊 GitFlow Database Migration Status\n');

  const pool = createPool();

  try {
    const migrationFiles = await getMigrationFiles();
    const appliedMigrations = await getAppliedMigrations(pool);

    console.log('Migration                              Status      Applied At');
    console.log('─'.repeat(75));

    for (const migration of migrationFiles) {
      const applied = appliedMigrations.get(migration.version);
      const status = applied !== undefined ? '✅ Applied' : '⏳ Pending';
      const appliedAt = applied !== undefined
        ? applied.applied_at.toISOString().split('T')[0]
        : '-';
      const checksumMatch =
        applied?.checksum === migration.checksum ? '' : ' ⚠️';

      console.log(
        `${migration.version.padEnd(40)} ${status}${checksumMatch}   ${appliedAt}`
      );
    }

    console.log('─'.repeat(75));

    const pendingCount = migrationFiles.length - appliedMigrations.size;
    console.log(`\nTotal: ${migrationFiles.length} migrations, ${appliedMigrations.size} applied, ${pendingCount} pending\n`);
  } finally {
    await pool.end();
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  // Load environment variables
  const dotenv = await import('dotenv');
  dotenv.config();

  const args = process.argv.slice(2);

  if (args.includes('--status') || args.includes('status')) {
    await showStatus();
  } else if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: npm run migrate [options]

Options:
  --status, status    Show migration status
  --dry-run          Preview migrations without executing
  --help, -h         Show this help message

Examples:
  npm run migrate              Run pending migrations
  npm run migrate -- --status  Show migration status
  npm run migrate -- --dry-run Preview migrations
`);
  } else {
    const dryRun = args.includes('--dry-run');
    await runMigrations(dryRun);
  }
}

main().catch((error: unknown) => {
  console.error('❌ Migration runner failed:', error);
  process.exit(1);
});
