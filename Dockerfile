FROM node:24-slim

# Git is required by the Claude Code SDK for repo operations
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy built application
COPY dist/ ./dist/
COPY public/ ./public/

EXPOSE 9800

CMD ["node", "dist/server.js"]
