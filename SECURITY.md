# Security Policy

## Fitur Keamanan Bawaan

- **Enkripsi Kredensial (`AES-256-GCM`)**: Token bot Telegram dan secret Webhook dienkripsi menggunakan kunci `APP_ENCRYPTION_KEY` sebelum disimpan ke database.
- **Autentikasi Probe (`SHA-256` Token Hash)**: Token autentikasi probe hanya ditampilkan satu kali saat registrasi dan disimpan dalam bentuk hash SHA-256.
- **Autentikasi Admin (`Argon2id` / `bcrypt` + `HttpOnly` JWT Cookie)**: Endpoint administrasi dan mutasi konfigurasi dilindungi oleh sesi JWT bertanda tangan (`JWT_SECRET`).
- **Isolasi Endpoint TV Display (`/api/tv/*`)**: Ketika `NOC_TV_ALLOW_UNAUTH=true`, hanya endpoint baca khusus wallboard (`/api/tv/matrix`, `/api/tv/series`, dan simulasi uji) yang diizinkan tanpa cookie sesi, sedangkan seluruh endpoint manajemen (`/api/matrix`, `/api/probes`, `/api/targets`, `/api/alerts`, `/api/settings`) tetap mewajibkan autentikasi.

## Rekomendasi Deployment Produksi

1. Selalu ganti nilai default pada `.env` (`POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `LOCAL_PROBE_TOKEN`) sebelum menjalankan di jaringan produksi.
2. Aktifkan `COOKIE_SECURE=true` saat diakses di balik reverse proxy HTTPS/TLS.
3. Batasi akses port database (`5432`) hanya pada jaringan internal Docker.

## Melaporkan Kerentanan

Jika Anda menemukan celah keamanan pada proyek ini, mohon jangan membuka *public issue* secara langsung. Silakan laporkan melalui fitur **GitHub Security Advisories** pada repositori [BadRush/smoker](https://github.com/BadRush/smoker/security) agar dapat ditangani terlebih dahulu sebelum dipublikasikan.
