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

## Quick Start & Setup Script

### 1. Setup Interaktif (Central Server atau Remote Probe)

Gunakan [`scripts/setup.sh`](scripts/setup.sh) untuk instalasi cepat pada server Central maupun node Remote Probe terpisah:

```bash
./scripts/setup.sh
```

Atau jalankan non-interaktif sesuai skema akses:

- **Mode Direct / Routed LAN / VPN**:
  ```bash
  ./scripts/setup.sh --role central --access direct --port 8080
  ```
- **Mode Cloudflared Zero Trust Tunnel** (termasuk hybrid agar probe LAN/VPN tetap bisa lewat IP internal):
  ```bash
  ./scripts/setup.sh --role central --access tunnel --domain smoker.example.com --tunnel-token "<TOKEN>" --bind 0.0.0.0
  ```
  Pada dashboard **Cloudflare Zero Trust -> Tunnels -> Public Hostname**, arahkan domain `smoker.example.com` ke service **`http://gateway:80`**.
- **Mode External Nginx Reverse Proxy + SSL**:
  ```bash
  ./scripts/setup.sh --role central --access nginx --domain smoker.example.com --bind 127.0.0.1
  ```
  Script menghasilkan vhost siap pakai `deploy/nginx/generated-<domain>.conf` lengkap dengan dukungan WebSocket (`/ws/probe`, `/ws/live`) dan header proxy (`X-Forwarded-Proto`, `X-Forwarded-For`, `X-Real-IP`).
- **Menambahkan Remote Probe Node (di VPS / cabang lain)**:
  ```bash
  ./scripts/setup.sh --role probe --central-url "wss://smoker.example.com/ws/probe" --probe-token "<PROBE_TOKEN>" --yes
  ```
  (Atau gunakan `ws://<IP-ROUTED-CENTRAL>:8080/ws/probe` bila terhubung langsung lewat LAN/WireGuard/BGP.)

### 2. Alur Komunikasi Multi-Topologi Probe <-> Central

- Seluruh probe berkomunikasi menggunakan **1 koneksi WebSocket keluar (*Outbound Push*)** ke `/ws/probe` sehingga probe di balik **NAT / CGNAT / Cloudflared** tidak memerlukan port inbound terbuka.
- Pada jaringan di balik **Cloudflared** atau **Nginx Proxy**, `deploy/nginx/default.conf` mempertahankan header `X-Forwarded-Proto` dan `CF-Connecting-IP` agar cookie sesi tetap `Secure` dan rate-limiter mencatat IP asli klien.
- Agent probe menjaga koneksi tetap hidup melalui **WebSocket Ping/Pong setiap 20 detik** (mendeteksi koneksi *half-open* dalam `< 30s`), *clock sync* setiap 30 detik, dan **SQLite WAL Store-and-Forward** agar telemetri tidak hilang saat tunnel atau proxy terputus.

### 3. Update & Maintenance (`scripts/update.sh`)

Gunakan [`scripts/update.sh`](scripts/update.sh) saat merilis pembaruan kode dari Git pada server Central maupun node Remote Probe tanpa kehilangan konfigurasi, token, maupun buffer data:

```bash
./scripts/update.sh
```

Script ini otomatis melakukan:
- **Auto-deteksi role** (`.env` untuk Central, `.probe.env` untuk Remote Probe, atau tentukan manual lewat `--role central|probe|all`).
- **Backup otomatis sebelum update**: menyalin `.env` / `.probe.env` (`*.bak.<timestamp>`) serta membuat backup TimescaleDB terkompresi `backups/smoker-pre-update-<timestamp>.sql.gz` (retensi default 5 arsip terakhir, lewati dengan `--no-backup`).
- **Sinkronisasi Git aman**: menjalankan `git pull --ff-only` (gunakan `--stash` bila ada modifikasi lokal, atau `--skip-pull` untuk rebuild workspace lokal).
- **Preserve Cloudflared / Nginx topology**: otomatis mempertahankan `--profile tunnel` bila `EXTERNAL_ACCESS_MODE=tunnel` dan me-render ulang vhost Nginx bila `EXTERNAL_ACCESS_MODE=nginx`.
- **Verifikasi kesehatan & cleanup**: menunggu `/readyz` Central + healthcheck `smoker-web`, lalu membersihkan dangling Docker images (`docker image prune -f`, lewati dengan `--no-prune`).

Contoh opsi lanjutan:
```bash
./scripts/update.sh --services central,web   # Rebuild backend API & UI saja (lebih cepat)
./scripts/update.sh --role probe             # Update container smoker-probe di remote node
./scripts/update.sh --stash --no-cache       # Stash editan lokal lalu clean build tanpa cache
```

---

## Struktur Direktori

| Path | Deskripsi |
| :--- | :--- |
| `scripts/setup.sh` | Script setup interaktif & CLI untuk Central (`direct`, `nginx`, `tunnel`) dan Remote Probe |
| `cmd/central/` | Entrypoint binary `smoker-central` (API server, WebSocket hub, migrator, scheduler alert) |
| `cmd/probe/` | Entrypoint binary `smoker-probe` (agen prober ringan dengan buffer SQLite WAL) |
| `internal/central/` | Modul backend: `db` (TimescaleDB), `ingest` (RollingCache & baseline), `httpapi`, `wshub`, `alerts`, `auth` |
| `internal/probe/` | Mesin prober (`icmp`, `icmp6`, `tcp`, `tcp6`, `http`, `http6`, `dns`, `dns6`, `mtr`), `clock` sync, `buffer` SQLite, dan `uplink` WS |
| `api/openapi.yaml` | Spesifikasi kontrak OpenAPI 3.0 untuk seluruh endpoint REST |
| `web/` | Aplikasi frontend Next.js 15 (React 18, Tailwind CSS, uPlot SmokePing renderer, Vitest) |
| `deploy/` | Dockerfile multi-stage, [`probe-agent.compose.yml`](deploy/docker/probe-agent.compose.yml), template Nginx/Cloudflared, dan E2E Playwright |

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
