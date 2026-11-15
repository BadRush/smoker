# Smoker — Distributed Real-Time SmokePing Modern

Monitoring latensi, jitter, packet loss, dan traceroute MTR terdistribusi dengan buffer **SQLite WAL Store-and-Forward** (*zero-gap* saat link Metro putus), **TimescaleDB** continuous aggregates, **Quorum Alerting**, dan **Modern Dark NOC UI**.

## Quick Start

1. Salin dan sesuaikan kredensial di `.env`:
   ```bash
   cp .env.example .env
   ```
2. Jalankan seluruh stack (`smoker-db`, `smoker-central`, `smoker-web`, `smoker-gateway`, `smoker-probe-local`):
   ```bash
   docker compose up -d --build
   ```
3. Buka UI NOC di `http://localhost:8080` (atau `https://${DOMAIN}` dengan `docker compose --profile tls up -d`).

## Verifikasi & Testing (Berbasis Docker)

- `make test-go` — `go vet` + unit tests dengan `-race`
- `make test-int` — integration tests terhadap container `smoker-db` TimescaleDB
- `make test-web` — ESLint, `tsc --noEmit`, dan Vitest
- `make codegen` — sinkronisasi `api/openapi.yaml` -> `web/src/lib/api-schema.d.ts`
