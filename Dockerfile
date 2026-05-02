FROM node:24-slim

# Git for SDK repo operations; curl/jq/ripgrep for the SDK to use
RUN apt-get update && \
    apt-get install -y git curl jq ripgrep && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (the SDK spawns it as a subprocess)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy built application. config/ is mounted at runtime from the host
# so personal CLAUDE.md never enters the image.
COPY dist/ ./dist/
COPY public/ ./public/
COPY drizzle/ ./drizzle/
RUN mkdir -p /app/config

# Run as nick (UID 1000) - Claude Code refuses bypassPermissions as root
USER 1000

EXPOSE 9800

CMD ["node", "dist/server.js"]
