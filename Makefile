.PHONY: deploy dev dev-server dev-worker dev-all seed dev-fresh typecheck typecheck-watch add-device list-devices remove-device restart-worker clear-conversations

deploy:
	git push
	ssh pixel-box "cd ~/remote_claude && git pull && npm install && sudo systemctl restart relay"

dev: dev-all

dev-server:
	NODE_ENV=development npx tsx watch src/server.ts

dev-worker:
	NODE_ENV=development npx tsx watch src/worker.ts

dev-all:
	$(MAKE) dev-server & $(MAKE) dev-worker & wait

seed:
	NODE_ENV=development npx tsx src/seed.ts

dev-fresh: seed dev-all

typecheck:
	npx tsc --noEmit

typecheck-watch:
	npx tsc --noEmit --watch

add-device:
	ssh pixel-box "cd ~/remote_claude && npx tsx src/cli.ts add"

list-devices:
	ssh pixel-box "cd ~/remote_claude && npx tsx src/cli.ts list"

remove-device:
	ssh pixel-box "cd ~/remote_claude && npx tsx src/cli.ts remove"

restart-worker:
	-pkill -f "tsx src/worker.ts"
	sleep 2
	npx tsx src/worker.ts &

clear-conversations:
	ssh pixel-box "cd ~/remote_claude && npx tsx src/cli.ts clear"
