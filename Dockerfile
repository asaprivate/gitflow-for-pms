# =============================================================================
# GitFlow MCP Server - Production Dockerfile
# =============================================================================
# Multi-stage build for optimized production image
# Base: Node.js 20 Alpine for minimal footprint
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies
# -----------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# Install build dependencies for native modules (if needed)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# -----------------------------------------------------------------------------
# Stage 2: Builder
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Prune devDependencies for production
RUN npm prune --production

# -----------------------------------------------------------------------------
# Stage 3: Production Runner
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 gitflow

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy only necessary files from builder
COPY --from=builder --chown=gitflow:nodejs /app/dist ./dist
COPY --from=builder --chown=gitflow:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=gitflow:nodejs /app/package.json ./package.json

# Create directory for cloned repositories (for production use)
RUN mkdir -p /home/gitflow/.gitflow-pm && \
    chown -R gitflow:nodejs /home/gitflow/.gitflow-pm

# Switch to non-root user
USER gitflow

# Expose MCP server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

# Start the application
CMD ["npm", "start"]
