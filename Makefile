build:
	docker build -t dgurney/care-log .

run:
	docker run \
		-v $(PWD)/local.db:/app/data/local.db \
		-e DB_FILE_NAME="file:/app/data/local.db" \
		-e BETTER_AUTH_SECRET=$CARELOG_BETTER_AUTH_SECRET \
		-e BETTER_AUTH_URL="http://localhost:3000" \
		-e ANTHROPIC_API_KEY=$CARELOG_ANTHROPIC_API_KEY \
		-e ALLOWED_EMAILS=$CARELOG_ALLOWED_EMAILS \
		-p 3000:3000 \
		dgurney/care-log

deploy:
	kamal deploy

push-local-db-to-prod:
	scp ./local.db root@5.161.95.107:/var/lib/docker/volumes/app_data/_data/local.db

pull-prod-db-to-local:
	scp root@5.161.95.107:/var/lib/docker/volumes/app_data/_data/local.db ./prod.db

.PHONY: build run push-local-db-to-prod pull-prod-db-to-local