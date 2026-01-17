/**
 * Logger utility using Pino
 *
 * Provides structured JSON logging with support for different log levels
 */

import pino from 'pino';

/**
 * Log levels available in the application
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Logger configuration options
 */
export interface ILoggerOptions {
  readonly level?: LogLevel;
  readonly name?: string;
  readonly prettyPrint?: boolean;
}

/**
 * Create a configured Pino logger instance
 */
export function createLogger(options: ILoggerOptions = {}): pino.Logger {
  const { level = 'info', name = 'gitflow-mcp', prettyPrint = false } = options;

  const isDevelopment = process.env['NODE_ENV'] === 'development';
  const usePrettyPrint = prettyPrint || isDevelopment;

  const baseOptions: pino.LoggerOptions = {
    name,
    level,
    base: {
      env: process.env['NODE_ENV'] ?? 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        'token',
        'password',
        'secret',
        'authorization',
        'github_token',
        'stripe_key',
        '*.token',
        '*.password',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
  };

  if (usePrettyPrint) {
    baseOptions.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  return pino(baseOptions);
}

/**
 * Default application logger instance
 */
export const logger = createLogger({
  level: (process.env['LOG_LEVEL'] as LogLevel) ?? 'info',
  prettyPrint: process.env['NODE_ENV'] === 'development',
});

/**
 * Create a child logger with additional context
 */
export function createChildLogger(
  bindings: pino.Bindings,
  parentLogger: pino.Logger = logger
): pino.Logger {
  return parentLogger.child(bindings);
}
