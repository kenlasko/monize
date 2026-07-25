.PHONY: start stop restart status logs clean start-dev start-local setup-env

# Default target: sets up environment and runs pre-built production images
start: setup-env
	docker compose up -d

# Sets up the .env file with generated secrets if not already present
setup-env:
	@node scripts/setup-env.js

# Stops the running containers
stop:
	docker compose down

# Restarts the containers
restart: stop start

# Shows status of all containers
status:
	docker compose ps

# Shows live logs from all containers
logs:
	docker compose logs -f

# Builds and runs the application locally from your source code
start-local: setup-env
	docker compose -f docker-compose.local.yml up -d --build

# Starts the application in live-reload development mode from local source code
start-dev: setup-env
	docker compose -f docker-compose.dev.yml up -d

# Stops containers and removes all persistent data volumes (resets application completely)
clean:
	docker compose down -v
