.PHONY: build dev start stop restart logs clean

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

# Cleanup
clean:
	rm -rf dist node_modules
