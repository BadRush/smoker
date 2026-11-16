.PHONY: up down logs build setup update test-go test-int test-web codegen verify

setup:
	bash scripts/setup.sh

update:
	bash scripts/update.sh

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

build:
	docker compose config -q
	docker compose build

test-go:
	docker run --rm -v "$(PWD):/src" -w /src golang:alpine \
		sh -c "apk add --no-cache build-base >/dev/null && CGO_ENABLED=1 go vet ./... && CGO_ENABLED=1 go test -race -count=1 ./..."

test-int:
	docker compose up -d db
	docker run --rm --network smoker_default -v "$(PWD):/src" -w /src \
		-e TEST_DATABASE_URL="postgres://$${POSTGRES_USER:-smoker}:$${POSTGRES_PASSWORD:-smoker_dev_password_change_me}@smoker-db:5432/$${POSTGRES_DB:-smoker}?sslmode=disable" \
		golang:alpine sh -c "apk add --no-cache build-base >/dev/null && CGO_ENABLED=1 go test -tags=integration -race -count=1 ./internal/central/db/... ./internal/central/ingest/..."

test-web:
	docker run --rm -v "$(PWD)/web:/app" -w /app node:22-alpine \
		sh -c "npm run lint && npx tsc --noEmit && npm test -- --run"

codegen:
	docker run --rm -v "$(PWD):/work" -w /work node:22-alpine \
		sh -c "npx --yes openapi-typescript ./api/openapi.yaml -o ./web/src/lib/api-schema.d.ts"

verify: build test-go test-web
