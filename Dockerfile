# ---- Builder: compile TS and resolve production deps ----
FROM node:24-slim AS builder

WORKDIR /app

# Install all deps (including devDependencies for tsc + drizzle-kit types)
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci

# Compile to dist/
COPY src/ ./src/
RUN npm run build

# Drop dev deps in place; the resulting node_modules is what the
# runtime stage ships.
RUN npm prune --omit=dev

# ---- Runtime ----
FROM node:24-slim

# Git for SDK repo operations; curl/jq/ripgrep for the SDK to use
RUN apt-get update && \
    apt-get install -y git curl jq ripgrep && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (the SDK spawns it as a subprocess)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Production deps and built artifacts from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Static assets and migration files from the build context
COPY public/ ./public/
COPY drizzle/ ./drizzle/
RUN mkdir -p /app/config

# Run as nick (UID 1000) - Claude Code refuses bypassPermissions as root
USER 1000

EXPOSE 9800

CMD ["node", "dist/server.js"]
