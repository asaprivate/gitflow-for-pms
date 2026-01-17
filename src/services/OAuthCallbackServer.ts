/**
 * OAuth Callback HTTP Server
 *
 * Provides an HTTP server to handle GitHub OAuth callbacks.
 * This runs alongside the MCP server to complete the OAuth flow.
 *
 * IMPORTANT: All logging goes to stderr to avoid breaking the MCP stdio stream.
 */

import express from 'express';
import type { Application, Request, Response, NextFunction, RequestHandler } from 'express';
import type { Server } from 'http';
import pino from 'pino';

import { authService } from './AuthService.js';
import { getConfig } from '../config/index.js';

/**
 * Create a stderr-only logger for the OAuth server
 * This is critical to avoid breaking the MCP stdio communication
 */
function createStderrLogger(): pino.Logger {
  const isDevelopment = process.env['NODE_ENV'] === 'development';

  const options: pino.LoggerOptions = {
    name: 'oauth-server',
    level: (process.env['LOG_LEVEL'] as string) ?? 'info',
    base: {
      env: process.env['NODE_ENV'] ?? 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  // Use pino-pretty for development, but always write to stderr
  if (isDevelopment) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        destination: 2, // stderr file descriptor
      },
    };
  }

  // Create logger that writes to stderr (fd 2)
  return pino(options, pino.destination(2));
}

const logger = createStderrLogger();

/**
 * HTML template for success page
 */
function getSuccessHtml(username: string, userId: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitFlow - Authentication Successful</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #10b981;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .icon svg { width: 48px; height: 48px; color: white; }
    h1 { color: #1f2937; font-size: 28px; margin-bottom: 16px; }
    p { color: #6b7280; font-size: 16px; line-height: 1.6; margin-bottom: 24px; }
    .username { color: #667eea; font-weight: 600; }
    .user-id {
      background: #f3f4f6;
      padding: 12px 16px;
      border-radius: 8px;
      font-family: monospace;
      font-size: 12px;
      color: #4b5563;
      word-break: break-all;
      margin-bottom: 24px;
    }
    .label { font-size: 11px; color: #9ca3af; text-transform: uppercase; margin-bottom: 4px; }
    .hint {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      padding: 16px;
      font-size: 14px;
      color: #1e40af;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
      </svg>
    </div>
    <h1>You're Connected!</h1>
    <p>Welcome, <span class="username">@${username}</span>! Your GitHub account is now connected to GitFlow.</p>
    <div class="label">Your User ID (save this)</div>
    <div class="user-id">${userId}</div>
    <div class="hint">
      You can close this window and return to your AI IDE. Use <code>check_auth_status</code> with your User ID to verify your connection.
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * HTML template for error page
 */
function getErrorHtml(error: string, details?: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitFlow - Authentication Failed</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #ef4444;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .icon svg { width: 48px; height: 48px; color: white; }
    h1 { color: #1f2937; font-size: 28px; margin-bottom: 16px; }
    p { color: #6b7280; font-size: 16px; line-height: 1.6; margin-bottom: 24px; }
    .error-box {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 16px;
      font-size: 14px;
      color: #991b1b;
      margin-bottom: 24px;
      text-align: left;
    }
    .error-title { font-weight: 600; margin-bottom: 8px; }
    .hint {
      background: #f3f4f6;
      border-radius: 8px;
      padding: 16px;
      font-size: 14px;
      color: #4b5563;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </div>
    <h1>Authentication Failed</h1>
    <p>We couldn't complete the GitHub authentication.</p>
    <div class="error-box">
      <div class="error-title">Error</div>
      ${error}${details ? `<br><br><small>${details}</small>` : ''}
    </div>
    <div class="hint">
      Return to your AI IDE and try <code>authenticate_github</code> again.
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * OAuth Callback Server class
 */
export class OAuthCallbackServer {
  private app: Application;
  private server: Server | null = null;
  private port: number;

  constructor() {
    const config = getConfig();
    // Extract port from redirect URI or use app.port
    const redirectUrl = new URL(config.github.redirectUri);
    this.port = parseInt(redirectUrl.port, 10) || config.app.port;

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware with stderr-only logging
   */
  private setupMiddleware(): void {
    // Request logging middleware - logs to stderr
    const requestLogger: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
      logger.debug({ method: req.method, path: req.path, query: req.query }, 'Incoming request');
      next();
    };
    this.app.use(requestLogger);
  }

  /**
   * Setup routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', service: 'oauth-callback-server' });
    });

    // OAuth callback endpoint
    this.app.get('/oauth/callback', (req: Request, res: Response): void => {
      void this.handleOAuthCallback(req, res);
    });

    // 404 handler
    this.app.use((_req: Request, res: Response) => {
      res.status(404).send('Not Found');
    });

    // Error handler - logs to stderr
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');
      res.status(500).send(getErrorHtml('Internal server error', err.message));
    });
  }

  /**
   * Handle OAuth callback from GitHub
   */
  private async handleOAuthCallback(req: Request, res: Response): Promise<void> {
    const { code, state, error, error_description } = req.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    // Handle GitHub OAuth errors
    if (error) {
      logger.warn({ error, error_description }, 'GitHub OAuth error');
      res.status(400).send(getErrorHtml(
        error === 'access_denied' ? 'Access was denied' : `OAuth error: ${error}`,
        error_description
      ));
      return;
    }

    // Validate required parameters
    if (!code || !state) {
      logger.warn({ hasCode: !!code, hasState: !!state }, 'Missing OAuth parameters');
      res.status(400).send(getErrorHtml(
        'Missing required parameters',
        'The callback URL is missing the authorization code or state parameter.'
      ));
      return;
    }

    try {
      logger.info({ state: state.substring(0, 8) + '...' }, 'Processing OAuth callback');

      // Exchange code for token and create/update user
      const result = await authService.handleOAuthCallback(code, state);

      logger.info(
        { userId: result.user.id, username: result.user.githubUsername },
        'OAuth callback successful'
      );

      // Send success page
      res.status(200).send(getSuccessHtml(result.user.githubUsername, result.user.id));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
      logger.error({ error: errorMessage }, 'OAuth callback failed');

      res.status(400).send(getErrorHtml(errorMessage));
    }
  }

  /**
   * Start the HTTP server
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          logger.info({ port: this.port }, 'OAuth callback server started');
          resolve();
        });

        this.server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            logger.error({ port: this.port }, 'Port already in use');
            reject(new Error(`Port ${this.port} is already in use`));
          } else {
            logger.error({ error: err.message }, 'Server error');
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the HTTP server
   */
  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('OAuth callback server stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the port the server is running on
   */
  public getPort(): number {
    return this.port;
  }
}

/**
 * Singleton instance
 */
let oauthServerInstance: OAuthCallbackServer | null = null;

/**
 * Get or create the OAuth callback server instance
 */
export function getOAuthCallbackServer(): OAuthCallbackServer {
  if (!oauthServerInstance) {
    oauthServerInstance = new OAuthCallbackServer();
  }
  return oauthServerInstance;
}

/**
 * Start the OAuth callback server
 */
export async function startOAuthCallbackServer(): Promise<OAuthCallbackServer> {
  const server = getOAuthCallbackServer();
  await server.start();
  return server;
}

/**
 * Stop the OAuth callback server
 */
export async function stopOAuthCallbackServer(): Promise<void> {
  if (oauthServerInstance) {
    await oauthServerInstance.stop();
    oauthServerInstance = null;
  }
}
