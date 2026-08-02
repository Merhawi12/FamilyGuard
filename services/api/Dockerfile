# ── Build stage ──────────────────────────────────────────────────────────────
# Installs production dependencies only. sqlite3 needs a toolchain to build its
# native binding; keeping that in a throwaway stage keeps the runtime image small.
FROM node:20-alpine AS deps

RUN apk add --no-cache python3 make g++
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Signal forwarding: without an init, the SIGTERM Cloud Run sends never reaches
# node as PID 1's child, and the instance is SIGKILLed after the grace period
# instead of draining its connections and closing the database pool.
RUN apk add --no-cache tini wget

ENV NODE_ENV=production \
    PORT=5000

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Run unprivileged — `node` (uid 1000) ships with the base image.
USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:5000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
