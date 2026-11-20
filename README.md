# Smoker — Distributed Multi-Probe SmokePing & MTR Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.24-00ADD8.svg)](go.mod)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](web/package.json)
[![TimescaleDB](https://img.shields.io/badge/TimescaleDB-PG16-FDB515.svg)](docker-compose.yml)

**Smoker** adalah platform monitoring latensi dan jalur jaringan (*latency & path observability*) real-time terdistribusi bergaya **SmokePing + Auto-MTR** dengan dukungan **IPv4/IPv6**, **NOC TV Wallboard**, dan **Quorum Alerting**.

---

## Fitur Utama

- **Multi-Probe Telemetry (IPv4 & IPv6)**
  - Memantau target secara serentak dari *Local Central Probe* maupun *Remote Probe* lintas lokasi/ISP menggunakan **ICMP/ICMPv6, TCP/TCPv6, HTTP/HTTPv6, dan DNS/DNSv6** (interval polling default `5s`, dapat dikonfigurasi per target `1s–300s`).
  - Penugasan target per-probe (*per-probe target assignment*) dan dukungan **Multi-Container Probe di 1 Host** (`--instance`, `--source-ip` / `--source-ip6`, atau Docker `macvlan`) dengan `ICMP ID` unik otomatis dan fallback soket *wildcard* bila binding `SOURCE_IP` gagal.
  - **SQLite WAL Store-and-Forward Buffer** (`MAX_BUFFER_MB=1024`, retensi `MAX_BUFFER_HOURS=168` jam) menjaga data sampel tetap utuh (*zero-gap*) saat koneksi uplink terputus, dilengkapi fallback DNS publik (`1.1.1.1` / `8.8.8.8`).

- **Grafik SmokePing Dual-Axis & Eksplorasi Interaktif**
  - Menyajikan *outer smoke cloud* (`min`–`p95`/`max`), *inner smoke cloud* (`p25`–`p75`), garis median (`NORMAL` / `p50`), serta **sumbu kanan Packet Loss (`0%–100%`)** dengan indikator batang vertikal loss.
  - **Pewarnaan garis dinamis per segmen waktu**:
    - **Hijau (`#10B981`)**: latensi dan kondisi paket normal.
    - **Kuning (`#FBBF24`)**: latensi menyentuh/melewati ambang (`p50 >= Warn` atau `p95 >= Warn * 1.25`) atau *intermittent packet loss* (`0 < loss < 50%`).
    - **Merah (`#F43F5E`)**: packet loss berat (`>= 50%`) atau *down* (`100%`).
  - Garis referensi horizontal **`WARN`** berjenjang: *Probe Latency Override* → *Target Warn Threshold* → *Adaptive Best-Path Baseline* (`max(P25 * 2, P25 + 15)` ms) → *Timeout Fallback*.
  - **Horizontal Drag-to-Zoom**: seret horizontal pada grafik mana pun untuk memperbesar rentang waktu dengan skala sumbu-Y adaptif, mempertahankan zoom saat *live tick* masuk, sinkronisasi lintas probe pada halaman detail, serta reset cepat lewat *double-click* atau tombol **`Reset Zoom`**.
  - **Hybrid Time Range Selector** seragam di `/tv`, Zoom Modal (`/` & `/tv`), dan `/targets/[id]`: mendukung preset cepat (`15m`, `1h`, `3h`, `6h`, `12h`, `24h`, **`3d`**, `7d`, **`30d`**, hingga `5m`/`1y` di halaman detail) serta **Custom Date & Time Range (24 jam)** dengan *quick pick* `Today` / `Yesterday` dan tautan URL shareable (`?from=&to=`).
  - **Target Zoom Modal & Deep Link**: inspeksi grafik detail dan MTR dari kartu mana pun di `/` maupun `/tv`, serta dukungan tautan langsung `?zoom=<target_id>` dari notifikasi Telegram.

- **TV Display / Kiosk Wallboard (`/tv`, alias `/display`)**
  - Topbar 3-zona ringkas (`SMOKER`, ringkasan KPI + indikator alert senyap, kontrol rentang waktu & preset).
  - Tata letak fleksibel: **Auto Best-Fit rasio `7:3`** (`1024x768`, `1080p`, `4K`, maupun `Portrait 9:16`), jumlah kolom kustom, mode **Static Grid** atau **Slides** berotasi, tampilan **Per-Probe** maupun **Per-Target**, serta filter grup/kategori, protokol (`ICMP`/`TCP`/`HTTP`/`DNS`), IP family (`IPv4`/`IPv6`), dan status **Alert / Warn**.
  - **Server-Side TV Presets**: simpan, bagikan, dan tetapkan preset tampilan default di database PostgreSQL agar seragam antar layar NOC.
  - **Mode SPOTLIGHT (Opt-In)**: pilihan `off` / `vip` / `all` untuk menyorot target yang mengalami `loss`/`down` atau prioritas **VIP**.
  - **Keamanan Kiosk (`NOC_TV_KIOSK_TOKEN`)**: dapat diakses tanpa login pada jaringan LAN tepercaya (`NOC_TV_ALLOW_UNAUTH=true`), atau dikunci menggunakan one-time link `/tv?key=<token>` yang menerbitkan cookie `HttpOnly` 365 hari (`smoker_tv_kiosk`) dan otomatis menghapus parameter `key` dari address bar. Mode historis (`?from=&to=`) tidak pernah disimpan ke `localStorage` maupun preset agar TV kiosk selalu kembali ke mode **LIVE** setelah reboot.

- **One-Click Copy / Export PNG Evidence**
  - Menyalin gambar bukti grafik PNG langsung ke clipboard (otomatis fallback mengunduh `.png` bila clipboard tidak didukung/ditolak) lengkap dengan statistik `BEST`, `NORMAL`, `HIGH`, `JITTER`, `AVG LOSS`, rentang tanggal/jam 24 jam, dan **Custom Brand Watermark** dari menu **Settings** (fallback otomatis **`Smoker by anamBadrus`**).

- **Automatic & On-Demand MTR Traceroute**
  - **Auto-MTR** terpicu secara otomatis saat terjadi **Packet Loss (`auto_loss`)** maupun **High Latency / Suboptimal Route (`auto_latency`)**, dilindungi mekanisme *edge-triggered anti-spam* (terpicu sekali saat insiden terkonfirmasi, throttle ulang setiap `15m` selama gangguan berkelanjutan, dan re-arm setelah `5` sampel sehat berturut-turut dengan cooldown `2m`).
  - **Manual MTR** dapat dipicu kapan saja per target/probe dari halaman `/targets/[id]` maupun langsung dari **Zoom Modal** pada `/` dan `/tv` (dengan rate-limit cooldown 30 detik pada endpoint `/tv`).

- **Quorum Alerting, Noise Control & Incident Tracking**
  - Evaluasi aturan alert berbasis kuorum multi-probe (`loss_pct`, `latency_p95`, `jitter`, `baseline_spike_pct`, `probe_offline`) baik berskala **Global** maupun per-target, lengkap dengan routing per-kanal dan filter severity (`all` / `critical`).
  - **Anti-Blip / Anti-Flap Hold-Down Timers** (`confirm_sec`, `recover_sec`), eskalasi otomatis `warn` → `critical`, pencatatan durasi SLA akurat, **Global Alerting Pause**, **Per-Target Alert Opt-In**, **Target Mute** sementara, serta aksi insiden (`Ack`, `Close`, `Clear`).
  - Kanal notifikasi **Telegram** (pesan ringkas berisi live readouts per probe, dukungan **Supergroup Topic / `thread_id`**, serta tautan **Open Live Graph** berbasis `PUBLIC_BASE_URL`) dan **Webhook**, dengan seluruh kredensial dienkripsi **AES-256-GCM**.

---

## Arsitektur Sistem

```
+----------------------------+      HTTP(S) / WS(S)     +------------------------------------------+
|   Browser / NOC TV (/tv)   | -----------------------> |      smoker-gateway (Nginx :8080)        |
+----------------------------+                          |   [Opsional: cloudflared / caddy TLS]    |
                                                        |                                          |
+----------------------------+  Outbound WS (/ws/probe) |                                          |
| smoker-probe-local +       | -----------------------> |        Proxy /api/*, /ws/* & UI          |
| Remote Probe(s)            |  (Multi-Instance,        +---------+----------------------+---------+
| (ICMP/TCP/HTTP/DNS/MTR +   |   SOURCE_IP / macvlan)      /api/* |                      | UI
|  SQLite WAL Buffer)        |                             /ws/*  v                      v
+----------------------------+                          +-------------------+  +-------------------+
                                                        |  smoker-central   |  |    smoker-web     |
                                                        | (Go API/WS Hub,   |  | (Next.js 15 UI,   |
                                                        |  RollingCache,    |  |  uPlot Dual-Axis, |
                                                        |  Quorum Alerter)  |  |  TV Wallboard)    |
                                                        +---------+---------+  +-------------------+
                                                                  |
                                                                  v
                                                        +-------------------+
                                                        |     smoker-db     |
                                                        | (TimescaleDB PG16 |
                                                        |  Hypertables +    |
                                                        |  Continuous Aggs) |
                                                        +-------------------+
```

---

## Halaman Antarmuka & Keyboard Shortcuts

### Rute Utama Web UI

| Rute | Fungsi |
| :--- | :--- |
| `/` | Dashboard utama: ringkasan matriks per-probe, grafik SmokePing, pencarian & filter, Zoom Modal |
| `/tv` *(alias `/display`)* | NOC TV Wallboard & Kiosk display dengan preset tersimpan, filter, dan mode Spotlight |
| `/targets` & `/targets/[id]` | Manajemen target (grup/kategori, sortir, paginasi, preset monitor publik, mute/alert toggle) & halaman detail multi-probe + histori MTR |
| `/probes` | Registrasi probe baru, one-liner setup script, rotasi token, dan status koneksi probe |
| `/alerts` | Manajemen aturan alert, kanal Telegram/Webhook, global alert pause, dan riwayat insiden (`Ack` / `Close`) |
| `/settings` | Pengaturan retensi data TimescaleDB, default quorum, custom screenshot watermark (+ live preview), dan ganti password admin |

### Keyboard Shortcuts

Tekan **`?`** di halaman mana pun untuk membuka cheatsheet shortcut interaktif. Seluruh shortcut otomatis dijeda saat kursor berada di dalam input form atau modal.

| Ruang Lingkup | Tombol | Fungsi |
| :--- | :--- | :--- |
| Global & Search | `Ctrl+F` atau `/` | Fokus ke kolom pencarian (`/`, `/targets`, `/tv`) |
| Global & Search | `Esc` | Hapus teks pencarian → keluar fokus, atau tutup modal / drawer / edit inline |
| Global & Search | `?` | Buka / tutup cheatsheet Keyboard Shortcuts |
| Manajemen | `n` | Buka form **New Target** (`/targets`) atau **Register Probe** (`/probes`) |
| TV Display (`/tv`) | `←` / `→` | Pindah slide carousel sebelumnya / berikutnya |
| TV Display (`/tv`) | `Space` | Play / Pause auto-rotasi pada mode Slides |
| TV Display (`/tv`) | `f` | Toggle layar penuh (*Fullscreen*) |
| TV Display (`/tv`) | `a` | Toggle filter target bermasalah (*Alert / Warn*) |
| TV Display (`/tv`) | `1` – `9` | Ganti rentang grafik (`15m`, `1h`, `3h`, `6h`, `12h`, `24h`, `3d`, `7d`, `30d`) |

---

## Quick Start & Setup Script

### 1. Setup Interaktif atau Non-Interaktif (`scripts/setup.sh`)

Jalankan wizard interaktif untuk instalasi **Central Server** maupun **Remote Probe**:

```bash
./scripts/setup.sh
```

Atau jalankan langsung dalam mode non-interaktif sesuai topologi jaringan:

- **Central — Mode Direct / Routed LAN / VPN**:
  ```bash
  ./scripts/setup.sh --role central --access direct --port 8080
  ```
- **Central — Mode Cloudflared Zero Trust Tunnel** *(termasuk hybrid agar probe LAN/VPN tetap dapat mengakses lewat IP internal)*:
  ```bash
  ./scripts/setup.sh --role central --access tunnel --domain smoker.example.com --tunnel-token "<TOKEN>" --bind 0.0.0.0
  ```
  Pada dashboard **Cloudflare Zero Trust → Tunnels → Public Hostname**, arahkan domain `smoker.example.com` ke service **`http://gateway:80`**.
- **Central — Mode External Nginx Reverse Proxy + SSL**:
  ```bash
  ./scripts/setup.sh --role central --access nginx --domain smoker.example.com --bind 127.0.0.1
  ```
  Script menghasilkan vhost siap pakai `deploy/nginx/generated-<domain>.conf` lengkap dengan dukungan WebSocket (`/ws/probe`, `/ws/live`) dan header proxy (`X-Forwarded-Proto`, `X-Forwarded-For`, `X-Real-IP`).
- **Menambahkan Remote Probe Node (di VPS / cabang lain)**:
  ```bash
  ./scripts/setup.sh --role probe --central-url "wss://smoker.example.com/ws/probe" --probe-token "<PROBE_TOKEN>" --yes
  ```
  *(Gunakan `ws://<IP-ROUTED-CENTRAL>:8080/ws/probe` bila terhubung lewat LAN/WireGuard/BGP, dan tambahkan `--tls-skip-verify` untuk sertifikat TLS internal/self-signed.)*
- **Multi-Container Probe di 1 Host (Sampling Beberapa IP Publik / 1:1 NAT)**:
  ```bash
  ./scripts/setup.sh --role probe \
    --instance pub1 \
    --source-ip 10.10.0.201 \
    --central-url "wss://smoker.example.com/ws/probe" \
    --probe-token "<PROBE_TOKEN>" \
    --yes
  ```
  Mendukung pula `--source-ip6` untuk dual-stack serta opsi Docker `macvlan` (`--macvlan-net`, `--macvlan-ip`).
  > Panduan lengkap prasyarat, provisioning, multi-container probe, dan troubleshooting tersedia di [`docs/probe-install.md`](docs/probe-install.md).

### 2. Variabel Lingkungan Penting (`.env`)

Seluruh template konfigurasi tersedia di [`.env.example`](.env.example). Variabel utama yang perlu diperhatikan sebelum produksi:

| Variabel | Default | Keterangan |
| :--- | :--- | :--- |
| `EXTERNAL_ACCESS_MODE` | `direct` | Topologi akses Central: `direct`, `nginx`, atau `tunnel` |
| `APP_PORT` / `GATEWAY_BIND_ADDR` | `8080` / `0.0.0.0` | Port & bind address `smoker-gateway` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / *(dev default)* | Kredensial admin awal (segera ganti untuk produksi; password juga bisa diubah di `/settings`) |
| `JWT_SECRET` / `APP_ENCRYPTION_KEY` | *(dev default)* | Kunci rahasia `>= 32` karakter untuk sesi JWT & enkripsi AES-256-GCM kredensial alert |
| `NOC_TV_ALLOW_UNAUTH` | `true` | Izinkan akses read-only `/tv` tanpa login admin di jaringan internal |
| `NOC_TV_KIOSK_TOKEN` | *(kosong)* | Token opsional pengunci `/tv`; bila diisi, buka `/tv?key=<token>` sekali per layar TV untuk menyimpan cookie `HttpOnly` 365 hari |
| `PUBLIC_BASE_URL` | *(kosong)* | Base URL (mis. `https://smoker.example.com`) untuk tautan **Open Live Graph** (`?zoom=...`) di alert Telegram |
| `COOKIE_SECURE` | `auto` | Set `auto` (mengikuti `X-Forwarded-Proto`), `true` (wajib HTTPS), atau `false` |
| `SEED_PUBLIC_MONITORS` | `true` | Otomatis mengisi target publik awal (DNS, Apps, IPv6) saat database masih kosong |

### 3. Alur Komunikasi Multi-Topologi Probe ↔ Central

- Seluruh probe berkomunikasi menggunakan **1 koneksi WebSocket keluar (*Outbound Push*)** ke `/ws/probe` tanpa membuka port inbound pada container probe, sehingga aman di balik **NAT / CGNAT / Cloudflared**.
- `deploy/nginx/default.conf` mempertahankan `X-Forwarded-Proto`, `CF-Connecting-IP`, dan `X-Real-IP` serta memakai DNS resolver dinamis (`127.0.0.11`) agar recreate container tidak menyisakan `502` stale upstream.
- Agent probe menjaga koneksi tetap hidup melalui **WebSocket Ping/Pong setiap 20 detik**, *clock sync* setiap 30 detik, dan **SQLite WAL Store-and-Forward** agar data tetap tersimpan selama gangguan uplink.

### 4. Update & Maintenance (`scripts/update.sh`)

Gunakan [`scripts/update.sh`](scripts/update.sh) saat merilis pembaruan kode dari Git pada Central maupun Remote Probe tanpa kehilangan konfigurasi, token, maupun buffer data:

```bash
./scripts/update.sh
```

Script ini otomatis melakukan:
- **Auto-deteksi role ketat** (`.env` untuk Central, `.probe.env` / `.probe.*.env` untuk Remote Probe, atau tentukan manual lewat `--role central|probe|all`).
- **Auto re-exec setelah `git pull`**: apabila `scripts/update.sh` sendiri ikut ter-update dari Git, script langsung mengeksekusi ulang versi terbarunya secara otomatis.
- **Backup otomatis sebelum update**: menyalin `.env` / `.probe*.env` (`*.bak.<timestamp>`) serta membuat dump TimescaleDB terkompresi `backups/smoker-pre-update-<timestamp>.sql.gz` (retensi default 5 arsip, lewati dengan `--no-backup`).
- **Preserve topologi Cloudflared / Nginx**: mempertahankan `--profile tunnel` bila `EXTERNAL_ACCESS_MODE=tunnel` dan me-render ulang vhost Nginx bila `EXTERNAL_ACCESS_MODE=nginx`.
- **Verifikasi kesehatan & cleanup**: menunggu `/readyz` Central + healthcheck `smoker-web`, lalu membersihkan dangling Docker images (`--no-prune` untuk melewati).

Contoh opsi lanjutan:
```bash
./scripts/update.sh --services central,web        # Rebuild backend API & UI saja (lebih cepat)
./scripts/update.sh --role probe                  # Update seluruh instance Remote Probe di host
./scripts/update.sh --role probe --instance pub1  # Update 1 instance Remote Probe tertentu
./scripts/update.sh --stash --no-cache            # Stash editan lokal lalu clean build tanpa cache
./scripts/update.sh --dry-run                     # Simulasi rencana update tanpa mengubah sistem
```

---

## Struktur Direktori

| Path | Deskripsi |
| :--- | :--- |
| `scripts/setup.sh` | Script setup interaktif & CLI untuk Central (`direct`, `nginx`, `tunnel`) dan Remote Probe (tunggal / multi-instance) |
| `scripts/update.sh` | Script update otomatis dengan pre-update DB backup, auto re-exec pasca-pull, dan verifikasi healthcheck |
| `cmd/central/` | Entrypoint binary `smoker-central` (API server, WebSocket hub, migrator, scheduler alert) |
| `cmd/probe/` | Entrypoint binary `smoker-probe` (agen prober ringan dengan buffer SQLite WAL) |
| `internal/central/` | Modul backend: `db` (TimescaleDB + `migrations/`), `ingest` (RollingCache & baseline), `httpapi`, `wshub`, `alerts`, `auth` |
| `internal/probe/` | Mesin prober (`icmp`, `icmp6`, `tcp`, `tcp6`, `http`, `http6`, `dns`, `dns6`, `mtr`), `clock` sync, `buffer` SQLite, dan `uplink` WS |
| `api/openapi.yaml` | Spesifikasi kontrak OpenAPI 3.0 untuk seluruh endpoint REST |
| `web/` | Aplikasi frontend Next.js 15 (React 18, Tailwind CSS, uPlot dual-axis renderer, Vitest) |
| `deploy/` | Dockerfile multi-stage, [`probe-agent.compose.yml`](deploy/docker/probe-agent.compose.yml), [`probe-macvlan.compose.yml`](deploy/docker/probe-macvlan.compose.yml), template Nginx/Caddy, dan E2E Playwright |
| `docs/` | Dokumentasi operasional tambahan, termasuk [`docs/probe-install.md`](docs/probe-install.md) |

---

## Perintah Pengembangan & Pengujian

Seluruh pengujian dan codegen dijalankan di dalam kontainer Docker melalui [`Makefile`](Makefile) (tidak memerlukan instalasi Go maupun Node.js lokal pada host):

- **Unit Test Go (vet + race detector)**:
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
- **Verifikasi Penuh (Build + Go Test + Web Test)**:
  ```bash
  make verify
  ```

---

## Dokumentasi Terkait & Lisensi

- [Panduan Instalasi & Multi-Instance Remote Probe](docs/probe-install.md)
- [Kontrak API OpenAPI 3.0](api/openapi.yaml)
- [Panduan Kontribusi](CONTRIBUTING.md)
- [Kebijakan Keamanan](SECURITY.md)

Didistribusikan di bawah lisensi [MIT License](LICENSE).
