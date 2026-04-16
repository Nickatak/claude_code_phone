FROM node:24-slim

# Git for SDK repo operations, python3 + build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y git python3 make g++ curl jq ripgrep && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (the SDK spawns it as a subprocess)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy built application and config
COPY dist/ ./dist/
COPY public/ ./public/
COPY config/ ./config/

# Create data dir and set ownership before dropping to non-root
RUN mkdir -p /app/data && chown -R 1000:1000 /app/data

# Run as nick (UID 1000) - Claude Code refuses bypassPermissions as root
USER 1000

EXPOSE 9800

CMD ["node", "dist/server.js"]
