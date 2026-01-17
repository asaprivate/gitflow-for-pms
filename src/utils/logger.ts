/**
 * Logger utility using Pino
 *
 * Provides structured JSON logging with support for different log levels.
 * 
 * IMPORTANT: All logs are written to stderr (file descriptor 2) to avoid
 * breaking the MCP stdio communication stream. MCP uses stdout for protocol
 * messages, so any application logs on stdout would corrupt the stream.
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
 * Stderr destination for all logs
 * Using file descriptor 2 ensures logs don't interfere with MCP stdio
 */
const stderrDestination = pino.destination(2);

/**
 * Create a configured Pino logger instance
 * All logs go to stderr to avoid breaking MCP stdio communication
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

  // When using pino-pretty, specify destination as stderr (fd 2)
  if (usePrettyPrint) {
    baseOptions.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        destination: 2, // stderr file descriptor
      },
    };
    // When using transport, pino handles the destination internally
    return pino(baseOptions);
  }

  // For JSON logging (production), explicitly use stderr destination
  return pino(baseOptions, stderrDestination);
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
