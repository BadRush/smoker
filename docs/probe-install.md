# Tutorial Singkat Instalasi Remote Probe Smoker

Panduan ini menjelaskan prasyarat, alur provisioning, cara instalasi **Remote Probe (`smoker-probe`)** di VPS/server cabang, hingga verifikasi koneksi ke **Smoker Central**.

> **Catatan:** Jika Anda baru memasang **Central Server**, *Local Central Probe* (`smoker-probe-local`) sudah otomatis terpasang dan aktif lewat `./scripts/setup.sh --role central`. Panduan ini khusus untuk menambahkan **Remote Probe** tambahan di node/lokasi lain.

---

## 1. Prasyarat

### Di Sisi Central Server
- **Smoker Central** sudah berjalan dan endpoint WebSocket `/ws/probe` dapat diakses secara **outbound** dari node probe:
  - **Publik (Cloudflared / Nginx SSL):** `wss://<domain-central>/ws/probe`
  - **LAN / WireGuard / VPN / Routed IP:** `ws://<ip-central>:8080/ws/probe`
- **One-Time Probe Token** yang dibuat dari menu **Probes (`/probes`)** di dashboard Smoker Central.

### Di Sisi Node Remote Probe (Linux)
- **OS:** Linux (probe berjalan dengan `network_mode: host` dan kapabilitas `NET_RAW` untuk ICMP & Auto-MTR).
- **Koneksi Jaringan:** Hanya butuh akses keluar (**outbound**) ke Central (`443/tcp` untuk `wss://` atau `8080/tcp` untuk `ws://`). Node probe **tidak memerlukan port inbound terbuka** sehingga aman di belakang NAT / CGNAT.
- **Paket Wajib (Metode Docker — Direkomendasikan):**
  - `git`
  - **Docker Engine** & **Docker Compose v2** (`docker compose version`)
- **Penyimpanan:** Minimal ~1–2 GB kosong untuk image container dan buffer SQLite WAL (`/data`, default batas `MAX_BUFFER_MB=1024`, retensi `MAX_BUFFER_HOURS=168` jam).
- **IPv6 (Opsional):** Jika memantau target `icmp6`, `tcp6`, `http6`, atau `dns6`, host node probe harus memiliki konektivitas IPv6 aktif.

---

## 2. Alur Instalasi

```
[1. Central UI: /probes -> Add Probe]
               │
               ▼  (Salin PROBE_TOKEN & URL Central)
[2. Node Probe: git clone repo Smoker]
               │
               ▼
[3. Jalankan ./scripts/setup.sh --role probe]
               │  └─ Membuat .probe.env + build & start container smoker-probe
               ▼
[4. Probe Terhubung Outbound ke /ws/probe]
               │  └─ Sinkronisasi target (config_sync) & mulai kirim sampel
               ▼
[5. Verifikasi Status "Online" di Central UI]
```

---

## 3. Langkah-Langkah Instalasi

### Langkah 1 — Buat Probe & Ambil Token di Central UI
1. Login ke dashboard **Smoker Central**, buka halaman **Probes** (`/probes`).
2. Klik tombol **Add Probe**.
3. Isi **Name**, **Location Label**, dan **ISP / ASN**, lalu simpan.
4. Pada panel **Probe Enrolled** yang muncul, pilih jalur **Uplink Path**:
   - **Cloudflared / Nginx (WSS)** jika melalui domain HTTPS/WSS.
   - **Routed / LAN / VPN IP (Direct WS)** jika langsung ke IP internal Central.
5. Salin perintah **One-Line Setup Script** (atau simpan `PROBE_TOKEN`-nya). Token plaintext hanya ditampilkan **satu kali** saat pembuatan.

### Langkah 2 — Clone Repository di Node Probe
Login ke server/VPS node probe via SSH, pastikan Docker & Git tersedia, lalu clone repo:

```bash
git clone https://github.com/BadRush/smoker.git
cd smoker
```

### Langkah 3 — Jalankan Setup Probe

#### Cara A: Non-Interaktif (One-Liner dari UI)
Gunakan URL dan token yang disalin dari Langkah 1:

- **Via Public Domain (Cloudflared / Nginx SSL):**
  ```bash
  ./scripts/setup.sh \
    --role probe \
    --central-url "wss://smoker.example.com/ws/probe" \
    --probe-token "<PROBE_TOKEN>" \
    --yes
  ```

- **Via LAN / VPN / Routed IP:**
  ```bash
  ./scripts/setup.sh \
    --role probe \
    --central-url "ws://10.10.0.5:8080/ws/probe" \
    --probe-token "<PROBE_TOKEN>" \
    --yes
  ```

> Tambahkan flag `--tls-skip-verify` apabila Central memakai sertifikat HTTPS internal / self-signed.

#### Cara B: Interaktif (Wizard)
```bash
./scripts/setup.sh
```
Pilih **`2) Remote Probe`**, pilih jenis koneksi (`1` untuk domain `wss://` atau `2` untuk IP routed `ws://`), lalu tempel `PROBE_TOKEN`.

Script akan otomatis membuat file `.probe.env` (`chmod 600`), membangun image dari [`deploy/docker/probe.Dockerfile`](../deploy/docker/probe.Dockerfile), dan menjalankan container `smoker-probe` memakai [`deploy/docker/probe-agent.compose.yml`](../deploy/docker/probe-agent.compose.yml).

### Langkah 4 — Verifikasi Status Probe
Cek log agent di node probe:
```bash
docker logs -f smoker-probe
```
Pastikan tidak ada error handshake/auth dan probe mulai menerima konfigurasi target. Selanjutnya buka kembali `/probes` di Central UI — status probe akan berubah menjadi **Online**.

---

## 4. Operasi Harian (Update & Troubleshooting)

### Update Versi Probe
Jalankan dari direktori `smoker` di node probe:
```bash
./scripts/update.sh --role probe
```
Konfigurasi `.probe.env` dan buffer SQLite WAL (`probe_remote_data`) tetap terjaga selama proses update.

### Mengganti / Memutar Token Probe (Jika Token Hilang)
1. Buka `/probes` di Central UI, klik **Rotate Token** pada probe terkait.
2. Perbarui nilai `PROBE_TOKEN` di file `.probe.env` pada node probe.
3. Restart container:
   ```bash
   docker compose -f deploy/docker/probe-agent.compose.yml --env-file .probe.env up -d --force-recreate
   ```

### Troubleshooting Singkat
| Gejala | Penyebab Umum & Solusi |
| :--- | :--- |
| `uplink ws handshake rejected` (`401`) | `PROBE_TOKEN` salah, kedaluwarsa, atau sudah di-rotate. Buat/rotate token di `/probes` lalu update `.probe.env`. |
| Gagal koneksi ke `wss://` (TLS error) | Sertifikat self-signed atau domain belum mengarah ke Central. Untuk sertifikat internal, set `PROBE_TLS_INSECURE_SKIP_VERIFY=true` di `.probe.env` lalu recreate container. |
| `init icmp prober failed` / permission denied | Pastikan container dijalankan memakai `deploy/docker/probe-agent.compose.yml` yang menyertakan `cap_add: [NET_RAW]` dan `network_mode: host`. |
| Target tetap terpantau saat uplink putus | Normal — sampel disimpan sementara di SQLite WAL (`/data/buffer.db`) hingga maksimal `MAX_BUFFER_MB` / `MAX_BUFFER_HOURS` dan dikirim ulang otomatis saat koneksi pulih. |
