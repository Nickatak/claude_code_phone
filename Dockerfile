FROM node:24-slim

# Git for SDK repo operations, python3 + build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y git python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy built application and config
COPY dist/ ./dist/
COPY public/ ./public/
COPY config/ ./config/

EXPOSE 9800

CMD ["node", "dist/server.js"]
