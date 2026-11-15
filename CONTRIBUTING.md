# Contributing to Smoker

Terima kasih atas kontribusi Anda pada pengembangan **Smoker**! Dokumen ini menjelaskan alur kerja pengembangan, standar kode, dan langkah verifikasi sebelum mengajukan *Pull Request*.

## Prasyarat Lingkungan

- **Docker** & **Docker Compose v2**
- **Go 1.24+** (opsional jika menjalankan test melalui kontainer Docker)
- **Node.js 22+** (opsional jika menjalankan test melalui kontainer Docker)

## Menjalankan Lingkungan Pengembangan

1. Buat file `.env` dari `.env.example`:
   ```bash
   cp .env.example .env
   ```
2. Bangun dan jalankan layanan:
   ```bash
   docker compose up -d --build
   ```

## Standar Kode & Arsitektur

1. **Kontrak API (`api/openapi.yaml`)**:
   - Setiap penambahan atau perubahan field pada response/request REST API wajib diperbarui di `api/openapi.yaml` dan disinkronkan ke `web/src/lib/api-schema.d.ts` (`make codegen`).
2. **Backend Go (`cmd/`, `internal/`)**:
   - Pastikan kode bebas dari peringatan `go vet` dan lulus pengujian konkurensi (`go test -race ./...`).
   - Gunakan *parameterized SQL queries* (`$1, $2, ...`) pada seluruh operasi database di `internal/central/db/`.
3. **Frontend Next.js (`web/`)**:
   - Jaga agar seluruh komponen lulus `npm run lint` dan `npx tsc --noEmit` tanpa error.
   - Untuk perubahan pada visualisasi grafik (`smoke-math.ts`, `smoke-canvas.ts`, `SmokeChartPanel.tsx`, `export-chart-png.ts`, `MiniSparkline.tsx`), sertakan unit test Vitest yang memverifikasi logika perhitungan dan penggambaran kanvas.

## Checklist Sebelum Pull Request

Jalankan rangkaian verifikasi berikut sebelum melakukan push:

```bash
# 1. Unit tests Go
docker run --rm -v "$(pwd)":/app -w /app golang:1.24-alpine go test ./internal/central/httpapi/... ./internal/central/ingest/... ./internal/central/alerts/...

# 2. Lint, Typecheck & Unit tests Web
docker run --rm -v "$(pwd)/web":/app -w /app node:22-alpine sh -c "npm run lint && npx tsc --noEmit && npm test -- --run"
```
