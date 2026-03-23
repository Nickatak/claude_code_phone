.PHONY: deploy dev dev-worker typecheck add-device list-devices remove-device restart-worker clear-conversations

deploy:
	git push
	ssh pixel-box "cd ~/remote_claude && git pull && npm install && sudo systemctl restart relay"

dev:
	npx tsx watch src/server.ts

dev-worker:
	npx tsx watch src/worker.ts

typecheck:
	npx tsc --noEmit

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
