.PHONY: help dev build start stop restart logs clean sync-claude docker-up docker-down docker-logs docker-rebuild docker-shell

# ============================================================================
# HELP
# ============================================================================

help:
	@echo "remote-claude - command reference"
	@echo ""
	@echo "Development"
	@echo "  make dev               Run dev server (tsx watch, hot reload)"
	@echo "  make build             Build TypeScript to dist/"
	@echo ""
	@echo "Docker"
	@echo "  make docker-up         Build and start container (detached)"
	@echo "  make docker-down       Stop and remove container"
	@echo "  make docker-rebuild    Force rebuild image and restart"
	@echo "  make docker-logs       Stream container logs"
	@echo "  make docker-shell      Shell into running container"
	@echo ""
	@echo "Utilities"
	@echo "  make sync-claude       Sync phone CLAUDE.md from global"
	@echo "  make clean             Remove dist/ and node_modules/"

# ============================================================================
# DEVELOPMENT
# ============================================================================

dev:
	npm run dev

build:
	npm run build

# ============================================================================
# DOCKER
# ============================================================================

docker-up: build
	docker compose up -d --build

docker-down:
	docker compose down --remove-orphans

docker-rebuild: build
	docker compose up -d --build --force-recreate

docker-logs:
	docker compose logs -f --tail=200

docker-shell:
	docker compose exec remote-claude sh

# ============================================================================
# UTILITIES
# ============================================================================

sync-claude:
	@cp ~/.claude/output-styles/personal.md config/CLAUDE.md
	@sed -i '1{/^---$$/!q};1,/^---$$/d' config/CLAUDE.md
	@sed -i 's/localhost:8191/host.docker.internal:8191/g' config/CLAUDE.md
	@cat config/phone-additions.md >> config/CLAUDE.md
	@echo "Synced config/CLAUDE.md from ~/.claude/output-styles/personal.md (frontmatter stripped, passthrough host patched, phone overrides appended)"

clean:
	rm -rf dist node_modules

.DEFAULT_GOAL := help
