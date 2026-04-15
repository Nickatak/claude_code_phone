.PHONY: build dev start stop restart logs clean sync-claude

# Development
dev:
	npm run dev

# Build TypeScript and Docker image
build:
	npm run build
	docker compose build

# Production (Docker)
start:
	docker compose up -d

stop:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f

# Sync phone CLAUDE.md from global, replacing the delivery rule
sync-claude:
	@cp ~/.claude/CLAUDE.md config/CLAUDE.md
	@sed -i 's/delivery: "substantial output to disk as stable artifacts; chat is the discussion layer; make a scratch dir if necessary"/delivery: "all output in chat; do not write files as artifacts"/' config/CLAUDE.md
	@echo "Synced config/CLAUDE.md from ~/.claude/CLAUDE.md (delivery rule patched for phone)"

# Cleanup
clean:
	rm -rf dist node_modules
