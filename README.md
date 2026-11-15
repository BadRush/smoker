# Smoker — Distributed Multi-Probe SmokePing & MTR Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.24-00ADD8.svg)](go.mod)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](web/package.json)
[![TimescaleDB](https://img.shields.io/badge/TimescaleDB-PG16-FDB515.svg)](docker-compose.yml)

**Smoker** adalah platform monitoring jaringan real-time terdistribusi bergaya **SmokePing + Auto-MTR** yang dirancang untuk kebutuhan **NOC (Network Operations Center)**, ISP, dan infrastruktur multi-pop.

---

## Fitur Utama

- **Multi-Probe Telemetry (ICMP, TCP, HTTP/HTTPS, DNS)**
  - Pengukuran serentak dari *Local Central Probe* maupun *Remote Probe* lintas lokasi/ISP melalui koneksi WebSocket persisten (`/ws/probe`).
  - **SQLite WAL Store-and-Forward Buffer** pada setiap probe menjaga sampel tetap utuh (*zero-gap*) saat koneksi uplink terputus dan melakukan sinkronisasi otomatis saat kembali online.
- **Grafik SmokePing Quantile & Pewarnaan Threshold Per Segmen**
  - Menyajikan *outer smoke cloud* (`min`–`p95`/`max`), *inner smoke cloud* (`p25`–`p75`), garis median (`NORMAL` / `p50`), dan indikator vertikal packet loss.
  - **Pewarnaan garis dinamis per segmen waktu**:
    - **Hijau (`#10B981`)**: latensi dan kondisi paket normal.
    - **Kuning (`#FBBF24`)**: latensi menyentuh/melewati ambang (`p50 >= Warn` atau `p95 >= Warn * 1.25`) atau terjadi *intermittent packet loss* (`0 < loss < 50%`).
    - **Merah (`#F43F5E`)**: packet loss berat (`>= 50%`) atau *down* (`100%`).
  - Dilengkapi garis referensi horizontal putus-putus **`WARN`** dengan perhitungan ambang berjenjang: *Probe Latency Override* → *Target Warn Threshold* → *Adaptive Best-Path Baseline* (`max(P25 * 2, P25 + 15)` ms) → *Timeout Fallback*.
- **TV Display / Kiosk Wallboard (`/tv`, `/display`, `/kiosk`)**
  - Tata letak **Auto Best-Fit rasio `7:3`** yang menyesuaikan jumlah kolom dan baris secara otomatis terhadap resolusi layar (`1024x768`, `1080p`, `4K`, maupun mode `Portrait 9:16`).
  - Mode default **Static** (tidak berpindah halaman otomatis kecuali rotasi diaktifkan).
  - Halaman **SPOTLIGHT** untuk menyorot host yang sedang mengalami anomali (`down`, `loss`, `HIGH RTT`) atau host prioritas (**Pin TV / VIP**), lengkap dengan perbandingan antar-probe dan simulasi uji 30 detik.
  - Pilihan rentang histori (`15m`, `1h`, `3h`, `6h`, `12h`, `24h`, `7d`) dan jam/tanggal format **24 jam**.
- **One-Click Copy / Export PNG Evidence**
  - Menyalin grafik ke clipboard (atau mengunduh file `.png` otomatis pada koneksi HTTP) lengkap dengan statistik `BEST`, `NORMAL`, `HIGH`, `JITTER`, `AVG LOSS`, rentang tanggal/jam 24h, dan tanpa mencantumkan nama internal probe agar siap dibagikan sebagai bukti teknis.
- **Automatic & On-Demand MTR Traceroute**
  - Menjalankan snapshot `mtr` otomatis saat terjadi packet loss berturut-turut melewati ambang atau secara manual per probe dari halaman detail target.
- **Quorum Alerting & Incident Tracking**
  - Evaluasi aturan alert berbasis kuorum multi-probe (`loss_pct`, `latency_p95`, `jitter`, `baseline_spike_pct`, `probe_offline`) dengan notifikasi **Telegram** dan **Webhook** (kredensial dienkripsi dengan **AES-256-GCM**).

---

## Arsitektur Sistem

```
+-------------------+        WebSocket (/ws/probe)       +--------------------+
|  Remote Probe(s)  | ---------------------------------> |                    |
| (ICMP/TCP/HTTP/   |   Batch Tick + Clock Sync + MTR    |   smoker-central   |
|  DNS + SQLite WAL)|                                    |  (Go HTTP/WS API,  |
+-------------------+                                    |   RollingCache,    |
                                                         |   Quorum Alerter)  |
+-------------------+        Loopback WebSocket          |                    |
| smoker-probe-local| ---------------------------------> |         |          |
+-------------------+                                    +---------+----------+
                                                                   |
                                            +----------------------+----------------------+
                                            |                                             |
                                            v                                             v
                                 +--------------------+                        +--------------------+
                                 |     smoker-db      |                        |     smoker-web     |
                                 | (TimescaleDB PG16  |                        |  (Next.js 15 UI,   |
                                 |  Hypertables +     |                        |   uPlot Canvas,    |
                                 |  Continuous Aggs)  |                        |   TV Wallboard)    |
                                 +--------------------+                        +--------------------+
```

---

## Quick Start

1. **Salin dan sesuaikan konfigurasi environment**:
   ```bash
   cp .env.example .env
   ```
2. **Jalankan seluruh stack dengan Docker Compose**:
   ```bash
   docker compose up -d --build
   ```
3. **Akses layanan**:
   - **Dashboard NOC**: `http://localhost:8080`
   - **TV Display / Kiosk**: `http://localhost:8080/tv`
   - **TLS Production (opsional dengan Caddy)**:
     ```bash
     docker compose --profile tls up -d --build
     ```

---

## Struktur Direktori

| Path | Deskripsi |
| :--- | :--- |
| `cmd/central/` | Entrypoint binary `smoker-central` (API server, WebSocket hub, migrator, scheduler alert) |
| `cmd/probe/` | Entrypoint binary `smoker-probe` (agen prober ringan dengan buffer SQLite WAL) |
| `internal/central/` | Modul backend: `db` (TimescaleDB), `ingest` (RollingCache & baseline), `httpapi`, `wshub`, `alerts`, `auth` |
| `internal/probe/` | Mesin prober (`icmp`, `tcp`, `http`, `dns`, `mtr`), `clock` sync, `buffer` SQLite, dan `uplink` WS |
| `api/openapi.yaml` | Spesifikasi kontrak OpenAPI 3.0 untuk seluruh endpoint REST |
| `web/` | Aplikasi frontend Next.js 15 (React 18, Tailwind CSS, uPlot SmokePing renderer, Vitest) |
| `deploy/` | Dockerfile multi-stage (`central`, `probe`, `web`), konfigurasi Nginx/Caddy, dan suite E2E Playwright |

---

## Perintah Pengembangan & Pengujian

Seluruh pengujian dapat dijalankan melalui `Makefile` maupun kontainer Docker:

- **Unit Test Go (dengan race detector)**:
  ```bash
  make test-go
  ```
- **Integration Test TimescaleDB**:
  ```bash
  make test-int
  ```
- **Lint, Typecheck & Unit Test Frontend (Vitest)**:
  ```bash
  make test-web
  ```
- **Sinkronisasi Schema OpenAPI ke TypeScript**:
  ```bash
  make codegen
  ```

---

## Lisensi

Didistribusikan di bawah lisensi [MIT License](LICENSE).
