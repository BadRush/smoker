# Security Policy

## Fitur Keamanan Bawaan

- **Enkripsi Kredensial (`AES-256-GCM`)**: Token bot Telegram dan secret Webhook dienkripsi menggunakan kunci `APP_ENCRYPTION_KEY` sebelum disimpan ke database.
- **Autentikasi Probe (`SHA-256` Token Hash)**: Token autentikasi probe hanya ditampilkan satu kali saat registrasi dan disimpan dalam bentuk hash SHA-256.
- **Autentikasi Admin (`Argon2id` / `bcrypt` + `HttpOnly` JWT Cookie)**: Endpoint administrasi dan mutasi konfigurasi dilindungi oleh sesi JWT bertanda tangan (`JWT_SECRET`).
- **Isolasi Endpoint TV Display (`/api/tv/*`) & Kiosk Token (`NOC_TV_KIOSK_TOKEN`)**: Ketika `NOC_TV_ALLOW_UNAUTH=true`, hanya endpoint khusus wallboard (`/api/tv/matrix`, `/api/tv/series`, `/api/tv/presets` baca, `/api/tv/targets/{id}/mtr`, serta trigger manual MTR `/api/tv/targets/{id}/mtr/run` yang dibatasi rate-limit cooldown 30 detik) dan WebSocket `/ws/live?scope=tv` yang dapat diakses tanpa sesi admin. Jika `NOC_TV_KIOSK_TOKEN` diisi, akses `/api/tv/*` dan `/ws/live?scope=tv` mewajibkan token kiosk satu kali via `/tv?key=<token>` yang menerbitkan cookie `HttpOnly` 365 hari (`smoker_tv_kiosk`) tanpa memberikan akses ke endpoint admin. Seluruh endpoint manajemen dan mutasi (`/api/matrix`, `/api/probes`, `/api/targets`, `/api/targets/{id}/simulate`, `/api/alerts`, `/api/settings`, serta penulisan `/api/tv/presets`) selalu mewajibkan autentikasi admin.

## Rekomendasi Deployment Produksi

1. Selalu ganti nilai default pada `.env` (`POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `LOCAL_PROBE_TOKEN`) sebelum menjalankan di jaringan produksi.
2. Jika `/tv` terekspos di luar LAN tepercaya (misalnya lewat domain publik / Cloudflared), set `NOC_TV_KIOSK_TOKEN` dengan token acak yang kuat atau matikan akses publik dengan `NOC_TV_ALLOW_UNAUTH=false`.
3. Aktifkan `COOKIE_SECURE=true` (atau biarkan `auto` di balik proxy yang meneruskan `X-Forwarded-Proto: https`) saat diakses melalui HTTPS/TLS.
4. Batasi akses port database (`5432`) hanya pada jaringan internal Docker.

## Melaporkan Kerentanan

Jika Anda menemukan celah keamanan pada proyek ini, mohon jangan membuka *public issue* secara langsung. Silakan laporkan melalui fitur **GitHub Security Advisories** pada repositori [BadRush/smoker](https://github.com/BadRush/smoker/security) agar dapat ditangani terlebih dahulu sebelum dipublikasikan.
