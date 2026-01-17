/**
 * Configuration module for GitFlow MCP Server
 *
 * Loads and validates environment variables and provides type-safe configuration
 */

import 'dotenv/config';

/**
 * Environment types supported by the application
 */
export type Environment = 'development' | 'staging' | 'production' | 'test';

/**
 * Application configuration interface
 */
export interface IAppConfig {
  readonly env: Environment;
  readonly port: number;
  readonly logLevel: string;
}

/**
 * Database configuration interface
 */
export interface IDatabaseConfig {
  readonly url: string;
  readonly poolMin: number;
  readonly poolMax: number;
}

/**
 * GitHub OAuth configuration interface
 */
export interface IGitHubConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

/**
 * Redis cache configuration interface
 */
export interface IRedisConfig {
  readonly url: string;
  readonly ttlSeconds: number;
}

/**
 * Stripe billing configuration interface
 */
export interface IStripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly proPriceId: string;
}

/**
 * JWT/Session configuration interface
 */
export interface IJwtConfig {
  readonly secret: string;
  readonly expiresIn: string;
  readonly issuer: string;
}

/**
 * Security configuration interface
 */
export interface ISecurityConfig {
  readonly keychainService: string;
  readonly oauthStateTtlSeconds: number;
}

/**
 * Complete application configuration
 */
export interface IConfig {
  readonly app: IAppConfig;
  readonly database: IDatabaseConfig;
  readonly github: IGitHubConfig;
  readonly redis: IRedisConfig;
  readonly stripe: IStripeConfig;
  readonly jwt: IJwtConfig;
  readonly security: ISecurityConfig;
}

/**
 * Get an environment variable with optional default value
 */
function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Get an environment variable as a number
 */
function getEnvNumber(key: string, defaultValue?: number): number {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got: ${value}`);
  }
  return parsed;
}

/**
 * Validate and return the environment type
 */
function getEnvironment(): Environment {
  const env = getEnv('NODE_ENV', 'development');
  const validEnvs: Environment[] = ['development', 'staging', 'production', 'test'];
  if (!validEnvs.includes(env as Environment)) {
    throw new Error(`Invalid NODE_ENV: ${env}. Must be one of: ${validEnvs.join(', ')}`);
  }
  return env as Environment;
}

/**
 * Create configuration object from environment variables
 * Throws if required variables are missing
 */
export function createConfig(): IConfig {
  const env = getEnvironment();
  const isDev = env === 'development' || env === 'test';

  return {
    app: {
      env,
      port: getEnvNumber('PORT', 3000),
      logLevel: getEnv('LOG_LEVEL', isDev ? 'debug' : 'info'),
    },
    database: {
      url: getEnv('DATABASE_URL', isDev ? 'postgresql://localhost:5432/gitflow_dev' : ''),
      poolMin: getEnvNumber('DB_POOL_MIN', 2),
      poolMax: getEnvNumber('DB_POOL_MAX', 10),
    },
    github: {
      clientId: getEnv('GITHUB_CLIENT_ID', isDev ? 'dev_client_id' : ''),
      clientSecret: getEnv('GITHUB_CLIENT_SECRET', isDev ? 'dev_client_secret' : ''),
      redirectUri: getEnv('GITHUB_REDIRECT_URI', 'http://localhost:3000/oauth/callback'),
      scopes: ['repo', 'user', 'read:org'] as const,
    },
    redis: {
      url: getEnv('REDIS_URL', isDev ? 'redis://localhost:6379' : ''),
      ttlSeconds: getEnvNumber('REDIS_TTL_SECONDS', 300),
    },
    stripe: {
      secretKey: getEnv('STRIPE_SECRET_KEY', isDev ? 'sk_test_xxx' : ''),
      webhookSecret: getEnv('STRIPE_WEBHOOK_SECRET', isDev ? 'whsec_xxx' : ''),
      proPriceId: getEnv('STRIPE_PRO_PRICE_ID', isDev ? 'price_xxx' : ''),
    },
    jwt: {
      secret: getEnv('JWT_SECRET', isDev ? 'dev-jwt-secret-change-in-production' : ''),
      expiresIn: getEnv('JWT_EXPIRES_IN', '7d'),
      issuer: getEnv('JWT_ISSUER', 'gitflow-for-pms'),
    },
    security: {
      keychainService: getEnv('KEYCHAIN_SERVICE', 'gitflow-for-pms'),
      oauthStateTtlSeconds: getEnvNumber('OAUTH_STATE_TTL_SECONDS', 300),
    },
  } as const;
}

/**
 * Singleton configuration instance
 * Lazily initialized on first access
 */
let configInstance: IConfig | null = null;

/**
 * Get the application configuration
 * Creates and caches the configuration on first call
 */
export function getConfig(): IConfig {
  if (configInstance === null) {
    configInstance = createConfig();
  }
  return configInstance;
}

/**
 * Reset the configuration instance (useful for testing)
 */
export function resetConfig(): void {
  configInstance = null;
}
