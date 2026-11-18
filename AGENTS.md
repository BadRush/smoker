# Smoker Workspace Rules & Engineering Guidelines

## 1. Toolchain, Testing, & Build Execution (Docker-Only Host)
The host OS does **not** have `go`, `node`, `npm`, or `npx` installed directly on `PATH`. Never run `go test` or `npm test` directly on the host shell. Always execute tests and builds via Docker containers:

- **Go Unit Tests**:
  ```bash
  docker run --rm -v /mnt/media/LAB26/smoker:/src -w /src golang:alpine go test ./internal/...
  ```
- **Frontend Unit Tests (Vitest)**:
  ```bash
  docker run --rm -v /mnt/media/LAB26/smoker/web:/app -w /app node:20-alpine npm test -- --run
  ```
- **OpenAPI TypeScript Codegen**:
  ```bash
  docker run --rm -v /mnt/media/LAB26/smoker:/work -w /work node:22-alpine npx --yes openapi-typescript ./api/openapi.yaml -o ./web/src/lib/api-schema.d.ts
  ```
- **Rebuild & Restart Live Stack**:
  ```bash
  docker compose up -d --build central web probe-local
  ```

## 2. Dashboard (`/`) & NOC TV Display (`/tv`) Feature Parity
Shared telemetry components (`SmokeChartPanel`, `TargetZoomModal`, `MtrSnapshotsPanel`, target cards, keyboard shortcuts like `Ctrl+F`, and `brand_name` settings) run in two distinct runtime scopes:
- **Authenticated Dashboard (`/`)**: Calls `/api/*` endpoints and subscribes with WebSocket scope `dashboard`.
- **Public / Kiosk NOC TV Display (`/tv`)**: Calls `/api/tv/*` endpoints (`requirePublicTV` middleware) and subscribes with WebSocket scope `tv`.

**Invariant**: Whenever adding or modifying interactive features in shared chart/modal components (e.g., Manual MTR trigger `/api/tv/targets/{id}/mtr/run`, WebSocket channel subscriptions like `target:<id>` in `internal/central/wshub/hub.go`, or matrix metadata in `/api/tv/matrix`), always implement and verify support for **both** `dashboard` and `tv` modes.

## 3. Telemetry Graph Card UI & PNG Export Conventions
Maintain a clean, high-density NOC presentation on all target graph cards (`FocalTargetCard` on `/tv` and `DashboardGridTargetCard` on `/`):
- **No Overlays Inside Plot Area**: Do not place floating action buttons, duplicate probe badges, or readout overlays inside the uPlot canvas container.
- **Card Header (Top-Left)**:
  - Row 1: Target Name + Protocol badge (`ICMP`, `TCP`, `HTTP`).
  - Row 2: Target Host / IP (`font-mono`).
- **Card Header (Top-Right)**:
  - Place `Reset Zoom` (when zoomed), `Zoom`, and `Screenshot` action buttons to the left of the status badge (`OK` / `WARN` / `DOWN`). Do not render a colored dot (`●`) inside the status badge.
- **Card Footer (Bottom Row)**:
  - **Bottom-Left**: Single canonical probe identity label (`<Probe Name> · <Location> · Every <N>s`).
  - **Bottom-Right**: `NORMAL / HIGH / LOSS` summary readouts aligned horizontally with the probe label (dynamically updated on chart cursor hover). Do not display a duplicate `Peak` readout.
- **Screenshot Export (`exportChartPng`)**:
  - Clicking the screenshot button must automatically copy the generated PNG to the clipboard (`navigator.clipboard.write` with `ClipboardItem` `image/png`) and fall back to downloading the `.png` file only if clipboard write is unsupported or denied.
  - Render the bottom-left watermark using the custom organization/brand name from Settings (`system_settings.brand_name` / `localStorage` key `smoker.branding.name.v1`). If empty or unset, automatically fall back to **`Smoker by anamBadrus`**.

## 4. Probe Architecture, Networking, & Auto-MTR Engine
- **Outbound-Only Probe Communication**: Probes (`cmd/probe`) connect outbound to Central (`/ws/probe`) via WebSocket using `Authorization: Bearer <SMOKER_PROBE_TOKEN>`. Probes must **never** publish container ports (`ports:`) to the host to avoid port conflicts.
- **DNS & Socket Resilience**:
  - Host systems using `systemd-resolved` (`127.0.0.53`) strip local DNS servers when Docker generates container `/etc/resolv.conf`. Always retain `fallbackPublicDNSResolver` (`1.1.1.1:53` / `8.8.8.8:53`) in `internal/probe/engine/icmp.go` and `mtr.go`, and keep `dns: [1.1.1.1, 8.8.8.8]` on probe services in `docker-compose.yml`.
  - When `SOURCE_IP` socket binding fails (`cannot assign requested address`), ICMP and MTR sockets must fall back gracefully to wildcard (`0.0.0.0` / `::`) rather than dropping all probes.
- **Auto-MTR Triggers & Edge-Triggered Anti-Spam**:
  - Auto-MTR triggers on both **Packet Loss** (`auto_loss`) and **High Latency / Suboptimal Route** (`auto_latency`, evaluated against target/per-probe `latency_warn_ms` or dynamic baseline).
  - Preserve edge-triggered anti-spam locking in `internal/probe/engine/scheduler.go`: fire once upon incident confirmation (`mtr_loss_threshold`), throttle repeat captures to every `15m` during sustained impairment, and reset only after `5` consecutive healthy ticks (with a `2m` re-arm cooldown).
