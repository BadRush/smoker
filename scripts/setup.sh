#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

ROLE=""
ACCESS_MODE=""
BIND_ADDR=""
APP_PORT="8080"
DOMAIN=""
TUNNEL_TOKEN=""
CENTRAL_URL=""
PROBE_TOKEN=""
TLS_SKIP_VERIFY="false"
TV_ALLOW_UNAUTH="true"
LOCAL_PROBE_NAME="Local Central Probe"
LOCAL_PROBE_LOCATION="Central Host"
AUTO_YES="false"
DRY_RUN="false"

usage() {
  cat <<'EOF'
Smoker Multi-Topology Setup Script

Usage:
  ./scripts/setup.sh [options]

Roles:
  --role central|probe          Setup Central Server stack or standalone Remote Probe node

Central Server options:
  --access direct|nginx|tunnel  Access topology:
                                  direct = Direct LAN / VPN / Routed IP (0.0.0.0:port)
                                  nginx  = Behind external Nginx reverse proxy (SSL + WS)
                                  tunnel = Built-in Cloudflare Zero Trust tunnel (--profile tunnel)
  --domain DOMAIN               Public domain name (e.g. smoker.example.com)
  --port PORT                   Host HTTP gateway port (default: 8080)
  --bind 127.0.0.1|0.0.0.0      Gateway bind IP (127.0.0.1 strict proxy/tunnel, 0.0.0.0 hybrid LAN/routed)
  --tunnel-token TOKEN          Cloudflare Zero Trust Tunnel token (for --access tunnel)
  --tv-unauth true|false        Allow unauthenticated read-only /tv wallboard (default: true)

Remote Probe Node options:
  --central-url URL             Central WebSocket URL:
                                  Cloudflared/Nginx: wss://smoker.example.com/ws/probe
                                  Routed LAN/VPN IP: ws://10.10.0.5:8080/ws/probe
  --probe-token TOKEN           One-time probe token from /probes UI
  --tls-skip-verify             Set PROBE_TLS_INSECURE_SKIP_VERIFY=true (self-signed internal Nginx TLS)

General options:
  --dry-run                     Generate config files only without running docker compose up
  -y, --yes                     Non-interactive mode (accept defaults when unspecified)
  -h, --help                    Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --access) ACCESS_MODE="${2:-}"; shift 2 ;;
    --bind) BIND_ADDR="${2:-}"; shift 2 ;;
    --port) APP_PORT="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="${2:-}"; shift 2 ;;
    --central-url) CENTRAL_URL="${2:-}"; shift 2 ;;
    --probe-token) PROBE_TOKEN="${2:-}"; shift 2 ;;
    --tls-skip-verify) TLS_SKIP_VERIFY="true"; shift ;;
    --tv-unauth) TV_ALLOW_UNAUTH="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="true"; shift ;;
    -y|--yes) AUTO_YES="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

log_info() { printf '\033[1;32m[smoker]\033[0m %s\n' "$*"; }
log_warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
log_err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

gen_secret() {
  local bytes="${1:-24}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log_err "Docker is not installed. Install Docker Engine + Compose plugin first."
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    log_err "Docker Compose v2 ('docker compose') is required."
    exit 1
  fi
}

detect_routed_ip() {
  local ip=""
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [[ -z "$ip" ]] && command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
  fi
  echo "${ip:-YOUR_CENTRAL_IP}"
}

prompt_choice() {
  local prompt="$1"
  local default="$2"
  local val=""
  if [[ "$AUTO_YES" == "true" ]]; then
    echo "$default"
    return
  fi
  read -r -p "$prompt [$default]: " val
  echo "${val:-$default}"
}

read_env_var() {
  local file="$1"
  local key="$2"
  if [[ -f "$file" ]]; then
    grep -E "^${key}=" "$file" | head -n1 | cut -d'=' -f2- || true
  fi
}

render_nginx_vhost() {
  local domain="$1"
  local upstream="$2"
  local out_file="${ROOT_DIR}/deploy/nginx/generated-${domain}.conf"
  sed -e "s|__DOMAIN__|${domain}|g" \
      -e "s|__UPSTREAM_ADDR__|${upstream}|g" \
      "${ROOT_DIR}/deploy/nginx/external-proxy.conf.template" > "${out_file}"
  chmod 644 "${out_file}"
  echo "${out_file}"
}

setup_central() {
  if [[ -z "$ACCESS_MODE" ]]; then
    if [[ "$AUTO_YES" == "true" ]]; then
      ACCESS_MODE="direct"
    else
      echo ""
      echo "Select Central Server access scheme:"
      echo "  1) Direct / Routed LAN / VPN  (expose 0.0.0.0:${APP_PORT}, probes connect ws://<IP>:${APP_PORT}/ws/probe)"
      echo "  2) External Nginx Proxy       (SSL domain -> external Nginx -> /ws/ & / on Smoker gateway)"
      echo "  3) Cloudflared Tunnel         (Zero Trust outbound tunnel container --profile tunnel)"
      local pick
      pick="$(prompt_choice 'Enter choice (1/2/3)' '1')"
      case "$pick" in
        2|nginx) ACCESS_MODE="nginx" ;;
        3|tunnel|cloudflared) ACCESS_MODE="tunnel" ;;
        *) ACCESS_MODE="direct" ;;
      esac
    fi
  fi

  case "$ACCESS_MODE" in
    direct|nginx|tunnel) ;;
    *) log_err "Invalid --access value: $ACCESS_MODE (expected direct|nginx|tunnel)"; exit 1 ;;
  esac

  if [[ "$ACCESS_MODE" == "direct" ]]; then
    DOMAIN="${DOMAIN:-localhost}"
    BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
  else
    if [[ -z "$DOMAIN" ]]; then
      DOMAIN="$(prompt_choice 'Enter public domain (e.g. smoker.example.com)' 'smoker.example.com')"
    fi
    if [[ -z "$BIND_ADDR" ]]; then
      if [[ "$AUTO_YES" == "true" ]]; then
        BIND_ADDR="127.0.0.1"
      else
        echo ""
        echo "Select host port bind for ${APP_PORT}:"
        echo "  1) Strict (127.0.0.1:${APP_PORT}) - UI & Probes connect only via ${ACCESS_MODE}"
        echo "  2) Hybrid (0.0.0.0:${APP_PORT})   - Public via ${ACCESS_MODE}, PLUS internal LAN/VPN/Routed Probes & TV direct"
        local bpick
        bpick="$(prompt_choice 'Enter bind mode (1/2)' '2')"
        if [[ "$bpick" == "1" ]]; then
          BIND_ADDR="127.0.0.1"
        else
          BIND_ADDR="0.0.0.0"
        fi
      fi
    fi
  fi

  if [[ -z "$TUNNEL_TOKEN" ]]; then
    TUNNEL_TOKEN="$(read_env_var "${ROOT_DIR}/.env" "CLOUDFLARE_TUNNEL_TOKEN")"
  fi
  if [[ "$ACCESS_MODE" == "tunnel" && -z "$TUNNEL_TOKEN" ]]; then
    if [[ "$AUTO_YES" != "true" ]]; then
      read -r -s -p "Enter Cloudflare Zero Trust TUNNEL_TOKEN: " TUNNEL_TOKEN
      echo ""
    fi
    if [[ -z "$TUNNEL_TOKEN" && "$DRY_RUN" != "true" ]]; then
      log_err "CLOUDFLARE_TUNNEL_TOKEN is required for --access tunnel"
      exit 1
    fi
  fi

  # Preserve existing secrets if .env already exists, otherwise generate fresh secure secrets
  local pg_db pg_user pg_pass admin_user admin_pass jwt_sec enc_key local_tok cookie_mode
  pg_db="$(read_env_var "${ROOT_DIR}/.env" "POSTGRES_DB")"; pg_db="${pg_db:-smoker}"
  pg_user="$(read_env_var "${ROOT_DIR}/.env" "POSTGRES_USER")"; pg_user="${pg_user:-smoker}"
  pg_pass="$(read_env_var "${ROOT_DIR}/.env" "POSTGRES_PASSWORD")"
  admin_user="$(read_env_var "${ROOT_DIR}/.env" "ADMIN_USERNAME")"; admin_user="${admin_user:-admin}"
  admin_pass="$(read_env_var "${ROOT_DIR}/.env" "ADMIN_PASSWORD")"
  jwt_sec="$(read_env_var "${ROOT_DIR}/.env" "JWT_SECRET")"
  enc_key="$(read_env_var "${ROOT_DIR}/.env" "APP_ENCRYPTION_KEY")"
  local_tok="$(read_env_var "${ROOT_DIR}/.env" "LOCAL_PROBE_TOKEN")"

  local generated_creds="false"
  if [[ -z "$pg_pass" ]]; then pg_pass="smk_pg_$(gen_secret 16)"; fi
  if [[ -z "$admin_pass" ]]; then admin_pass="smk_adm_$(gen_secret 10)"; generated_creds="true"; fi
  if [[ -z "$jwt_sec" ]]; then jwt_sec="$(gen_secret 32)"; fi
  if [[ -z "$enc_key" ]]; then enc_key="$(gen_secret 32)"; fi
  if [[ -z "$local_tok" ]]; then local_tok="smk_local_$(gen_secret 24)"; fi
  cookie_mode="auto"

  if [[ -f "${ROOT_DIR}/.env" ]]; then
    cp "${ROOT_DIR}/.env" "${ROOT_DIR}/.env.bak"
    log_info "Backed up existing .env -> .env.bak"
  fi

  cat > "${ROOT_DIR}/.env" <<EOF
# Generated by scripts/setup.sh ($(date -u +"%Y-%m-%dT%H:%M:%SZ"))
EXTERNAL_ACCESS_MODE=${ACCESS_MODE}
GATEWAY_BIND_ADDR=${BIND_ADDR}
APP_PORT=${APP_PORT}
DOMAIN=${DOMAIN}

CLOUDFLARE_TUNNEL_TOKEN=${TUNNEL_TOKEN}

POSTGRES_DB=${pg_db}
POSTGRES_USER=${pg_user}
POSTGRES_PASSWORD=${pg_pass}

ADMIN_USERNAME=${admin_user}
ADMIN_PASSWORD=${admin_pass}

JWT_SECRET=${jwt_sec}
APP_ENCRYPTION_KEY=${enc_key}

LOCAL_PROBE_AUTO_ENROLL=true
LOCAL_PROBE_NAME=${LOCAL_PROBE_NAME}
LOCAL_PROBE_LOCATION=${LOCAL_PROBE_LOCATION}
LOCAL_PROBE_TOKEN=${local_tok}

SEED_PUBLIC_MONITORS=true
NOC_TV_ALLOW_UNAUTH=${TV_ALLOW_UNAUTH}
COOKIE_SECURE=${cookie_mode}
EOF
  chmod 600 "${ROOT_DIR}/.env"
  log_info "Wrote ${ROOT_DIR}/.env (mode=${ACCESS_MODE}, bind=${BIND_ADDR}:${APP_PORT})"

  local nginx_conf=""
  if [[ "$ACCESS_MODE" == "nginx" ]]; then
    nginx_conf="$(render_nginx_vhost "${DOMAIN}" "127.0.0.1:${APP_PORT}")"
    log_info "Generated Nginx reverse proxy template: ${nginx_conf}"
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "Dry run enabled; skipping 'docker compose up'."
  else
    check_docker
    if [[ "$ACCESS_MODE" == "tunnel" ]]; then
      docker compose --profile tunnel up -d --build
    else
      docker compose up -d --build
    fi

    log_info "Waiting for Central readiness check..."
    local ready="false"
    for _ in $(seq 1 30); do
      if docker exec smoker-central wget -qO- http://127.0.0.1:8080/readyz >/dev/null 2>&1; then
        ready="true"
        break
      fi
      sleep 2
    done
    if [[ "$ready" != "true" ]]; then
      log_warn "Central did not become ready within 60s; check 'docker compose logs central'."
    fi
  fi

  local routed_ip
  routed_ip="$(detect_routed_ip)"

  echo ""
  echo "==================== SMOKER CENTRAL READY ===================="
  if [[ "$ACCESS_MODE" == "tunnel" ]]; then
    echo "Access Mode       : Cloudflared Zero Trust Tunnel"
    echo "Cloudflare Setup  : Zero Trust -> Tunnels -> Public Hostname:"
    echo "                    Domain: ${DOMAIN}  -->  Service: HTTP://gateway:80"
    echo "Web & TV URL      : https://${DOMAIN}  (TV: https://${DOMAIN}/tv)"
    echo "Probe WS (Public) : wss://${DOMAIN}/ws/probe"
  elif [[ "$ACCESS_MODE" == "nginx" ]]; then
    echo "Access Mode       : External Nginx Reverse Proxy"
    echo "Vhost Template    : ${nginx_conf}"
    echo "Install Command   : sudo cp \"${nginx_conf}\" /etc/nginx/sites-available/smoker.conf && sudo ln -sf /etc/nginx/sites-available/smoker.conf /etc/nginx/sites-enabled/smoker.conf && sudo nginx -t && sudo systemctl reload nginx"
    echo "Enable TLS        : sudo certbot --nginx -d ${DOMAIN}"
    echo "Web & TV URL      : https://${DOMAIN}  (TV: https://${DOMAIN}/tv)"
    echo "Probe WS (Public) : wss://${DOMAIN}/ws/probe"
  else
    echo "Access Mode       : Direct / Routed LAN / VPN"
    echo "Web & TV URL      : http://${routed_ip}:${APP_PORT}  (TV: http://${routed_ip}:${APP_PORT}/tv)"
  fi
  if [[ "$BIND_ADDR" == "0.0.0.0" ]]; then
    echo "Probe WS (Routed) : ws://${routed_ip}:${APP_PORT}/ws/probe"
  fi
  echo "Admin Username    : ${admin_user}"
  if [[ "$generated_creds" == "true" ]]; then
    echo "Admin Password    : ${admin_pass}  (saved in .env; change after login in Settings)"
  else
    echo "Admin Password    : (preserved from existing .env)"
  fi
  echo "=============================================================="
}

setup_probe() {
  if [[ -z "$CENTRAL_URL" ]]; then
    if [[ "$AUTO_YES" == "true" ]]; then
      log_err "--central-url is required in non-interactive --role probe mode"
      exit 1
    fi
    echo ""
    echo "Select how this Remote Probe connects to Smoker Central:"
    echo "  1) Via Public Domain (Cloudflared Tunnel / Nginx SSL -> wss://<domain>/ws/probe)"
    echo "  2) Via Routed LAN / VPN / Direct IP               -> ws://<ip>:8080/ws/probe"
    local tpick
    tpick="$(prompt_choice 'Enter choice (1/2)' '1')"
    if [[ "$tpick" == "2" ]]; then
      local rhost
      rhost="$(prompt_choice 'Central Routed IP:Port' '10.10.0.5:8080')"
      CENTRAL_URL="ws://${rhost}/ws/probe"
    else
      local pdom
      pdom="$(prompt_choice 'Central Public Domain' 'smoker.example.com')"
      CENTRAL_URL="wss://${pdom}/ws/probe"
    fi
  fi

  # Normalize trailing slash or bare host/URL cleanly
  if [[ "$CENTRAL_URL" =~ ^https:// ]]; then
    CENTRAL_URL="wss://${CENTRAL_URL#https://}"
  elif [[ "$CENTRAL_URL" =~ ^http:// ]]; then
    CENTRAL_URL="ws://${CENTRAL_URL#http://}"
  elif [[ ! "$CENTRAL_URL" =~ ^wss?:// ]]; then
    CENTRAL_URL="wss://${CENTRAL_URL}"
  fi
  CENTRAL_URL="${CENTRAL_URL%/}"
  if [[ "$CENTRAL_URL" != */ws/probe ]]; then
    CENTRAL_URL="${CENTRAL_URL}/ws/probe"
  fi

  if [[ -z "$PROBE_TOKEN" ]]; then
    if [[ "$AUTO_YES" == "true" ]]; then
      log_err "--probe-token is required in non-interactive --role probe mode"
      exit 1
    fi
    read -r -s -p "Enter PROBE_TOKEN (from Central /probes -> Add Probe): " PROBE_TOKEN
    echo ""
    if [[ -z "$PROBE_TOKEN" ]]; then
      log_err "PROBE_TOKEN cannot be empty"
      exit 1
    fi
  fi

  cat > "${ROOT_DIR}/.probe.env" <<EOF
# Generated by scripts/setup.sh ($(date -u +"%Y-%m-%dT%H:%M:%SZ"))
CENTRAL_URL=${CENTRAL_URL}
PROBE_TOKEN=${PROBE_TOKEN}
PROBE_TLS_INSECURE_SKIP_VERIFY=${TLS_SKIP_VERIFY}
MAX_BUFFER_MB=1024
MAX_BUFFER_HOURS=168
AGENT_VERSION=1.0.0
EOF
  chmod 600 "${ROOT_DIR}/.probe.env"
  log_info "Wrote ${ROOT_DIR}/.probe.env"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "Dry run enabled; skipping 'docker compose up'."
  else
    check_docker
    docker compose -f "${ROOT_DIR}/deploy/docker/probe-agent.compose.yml" --env-file "${ROOT_DIR}/.probe.env" up -d --build
    sleep 3
    docker logs --tail=15 smoker-probe || true
  fi

  echo ""
  echo "==================== SMOKER REMOTE PROBE ===================="
  echo "Central Uplink WS : ${CENTRAL_URL}"
  echo "SQLite WAL Buffer : volume 'probe_remote_data' (/data, max 1024 MB / 168h)"
  echo "Status Check      : docker logs -f smoker-probe"
  echo "============================================================="
}

if [[ -z "$ROLE" ]]; then
  if [[ "$AUTO_YES" == "true" ]]; then
    ROLE="central"
  else
    echo ""
    echo "Smoker Setup Wizard"
    echo "  1) Central Server  (DB + Central API + Web UI + Local Probe + optional Cloudflared/Nginx)"
    echo "  2) Remote Probe    (Lightweight agent pushing over WSS/WS with SQLite WAL store-and-forward)"
    rpick="$(prompt_choice 'Select deployment role (1/2)' '1')"
    if [[ "$rpick" == "2" ]]; then
      ROLE="probe"
    else
      ROLE="central"
    fi
  fi
fi

case "$ROLE" in
  central) setup_central ;;
  probe) setup_probe ;;
  *) log_err "Invalid --role '$ROLE' (expected central|probe)"; exit 1 ;;
esac
