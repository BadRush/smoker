#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

ROLE="auto"
BRANCH=""
SKIP_PULL="false"
STASH_LOCAL="false"
DO_BACKUP="true"
BACKUP_KEEP="5"
NO_CACHE="false"
DO_PRUNE="true"
SERVICES_CSV=""
INSTANCE_FILTER=""
DRY_RUN="false"

usage() {
  cat <<'EOF'
Smoker Update Script (Central Server & Remote Probe)

Usage:
  ./scripts/update.sh [options]

Options:
  --role auto|central|probe|all   Target deployment role (default: auto via .env / .probe*.env)
  --branch BRANCH                 Git branch to pull (default: current active branch)
  --skip-pull                     Skip 'git pull --ff-only' and rebuild from local files only
  --stash                         Auto-stash dirty tracked files before 'git pull --ff-only'
  --no-backup                     Skip pre-update TimescaleDB pg_dump backup (Central)
  --backup-keep N                 Number of backups/*.sql.gz files to retain (default: 5)
  --services s1,s2,...            Comma-separated Central services to rebuild/restart (e.g. central,web)
  --instance NAME                 Update only a single named Remote Probe instance (e.g. pub1 or default)
  --no-cache                      Pass --no-cache to 'docker compose build'
  --no-prune                      Skip 'docker image prune -f' after successful update
  --dry-run                       Show planned actions without modifying git, backups, or containers
  -h, --help                      Show this help message

Examples:
  ./scripts/update.sh                              # Auto-detect role, backup DB, pull, rebuild & verify
  ./scripts/update.sh --services central,web       # Fast update of backend API + frontend only
  ./scripts/update.sh --role probe                 # Update all Remote Probe container instances on host
  ./scripts/update.sh --role probe --instance pub1 # Update only .probe.pub1.env instance
  ./scripts/update.sh --stash --no-cache           # Stash local edits, pull, and clean-rebuild
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --skip-pull) SKIP_PULL="true"; shift ;;
    --stash) STASH_LOCAL="true"; shift ;;
    --no-backup) DO_BACKUP="false"; shift ;;
    --backup-keep) BACKUP_KEEP="${2:-}"; shift 2 ;;
    --services) SERVICES_CSV="${2:-}"; shift 2 ;;
    --instance) INSTANCE_FILTER="${2:-}"; shift 2 ;;
    --no-cache) NO_CACHE="true"; shift ;;
    --no-prune) DO_PRUNE="false"; shift ;;
    --dry-run) DRY_RUN="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

log_info() { printf '\033[1;32m[smoker-update]\033[0m %s\n' "$*"; }
log_warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
log_err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

if ! [[ "$BACKUP_KEEP" =~ ^[0-9]+$ ]] || [[ "$BACKUP_KEEP" -lt 1 ]]; then
  log_err "--backup-keep must be a positive integer (got: '$BACKUP_KEEP')"
  exit 1
fi

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log_err "Docker is not installed."
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    log_err "Docker Compose v2 ('docker compose') is required."
    exit 1
  fi
}

read_env_var() {
  local file="$1"
  local key="$2"
  if [[ -f "$file" ]]; then
    grep -E "^${key}=" "$file" | head -n1 | cut -d'=' -f2- | tr -d '\r' || true
  fi
}

list_probe_env_files() {
  local -a files=()
  local f base inst
  if [[ -n "$INSTANCE_FILTER" ]]; then
    inst="$(echo "$INSTANCE_FILTER" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    if [[ "$inst" == "default" ]]; then
      [[ -f "${ROOT_DIR}/.probe.env" ]] && echo "${ROOT_DIR}/.probe.env"
      return
    fi
    [[ -f "${ROOT_DIR}/.probe.${inst}.env" ]] && echo "${ROOT_DIR}/.probe.${inst}.env"
    return
  fi

  if [[ -f "${ROOT_DIR}/.probe.env" ]]; then
    files+=("${ROOT_DIR}/.probe.env")
  fi
  shopt -s nullglob
  for f in "${ROOT_DIR}"/.probe.*.env; do
    base="$(basename "$f")"
    if [[ "$base" == *.bak.* ]]; then
      continue
    fi
    files+=("$f")
  done
  shopt -u nullglob
  if [[ ${#files[@]} -gt 0 ]]; then
    printf '%s\n' "${files[@]}"
  fi
}

backup_env_files() {
  local ts="$1"
  if [[ -f "${ROOT_DIR}/.env" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[dry-run] Would back up .env -> .env.bak.${ts}"
    else
      cp "${ROOT_DIR}/.env" "${ROOT_DIR}/.env.bak.${ts}"
      chmod 600 "${ROOT_DIR}/.env.bak.${ts}"
      log_info "Backed up .env -> .env.bak.${ts}"
    fi
  fi
  local pfile pbase
  while IFS= read -r pfile; do
    [[ -z "$pfile" ]] && continue
    pbase="$(basename "$pfile")"
    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[dry-run] Would back up ${pbase} -> ${pbase}.bak.${ts}"
    else
      cp "$pfile" "${pfile}.bak.${ts}"
      chmod 600 "${pfile}.bak.${ts}"
      log_info "Backed up ${pbase} -> ${pbase}.bak.${ts}"
    fi
  done < <(list_probe_env_files)
}

detect_roles() {
  if [[ "$ROLE" != "auto" ]]; then
    case "$ROLE" in
      central|probe|all) echo "$ROLE"; return ;;
      *) log_err "Invalid --role '$ROLE' (expected auto|central|probe|all)"; exit 1 ;;
    esac
  fi

  local has_central="false"
  local has_probe="false"
  if [[ -f "${ROOT_DIR}/.env" ]] || docker ps -a --format '{{.Names}}' 2>/dev/null | awk '/^smoker-(central|db|web|gateway)$/ { found=1 } END { exit !found }'; then
    has_central="true"
  fi
  # Exclude built-in 'smoker-probe-local' (managed by Central compose) when detecting standalone Remote Probe containers
  if [[ -n "$(list_probe_env_files)" ]] || docker ps -a --format '{{.Names}}' 2>/dev/null | awk '/^smoker-probe($|-)/ && $0 != "smoker-probe-local" { found=1 } END { exit !found }'; then
    has_probe="true"
  fi

  if [[ "$has_central" == "true" && "$has_probe" == "true" ]]; then
    echo "all"
  elif [[ "$has_probe" == "true" ]]; then
    echo "probe"
  elif [[ "$has_central" == "true" ]]; then
    echo "central"
  else
    log_err "Could not auto-detect Smoker installation (.env or .probe*.env not found). Pass --role central|probe or run ./scripts/setup.sh first."
    exit 1
  fi
}

pull_updates() {
  local ts="$1"
  if [[ "$SKIP_PULL" == "true" ]]; then
    log_info "Skipping git pull (--skip-pull enabled)."
    return
  fi
  if [[ ! -d "${ROOT_DIR}/.git" ]]; then
    log_warn "No .git repository directory found; skipping git pull and using local workspace."
    return
  fi

  local active_branch="$BRANCH"
  if [[ -z "$active_branch" ]]; then
    active_branch="$(git rev-parse --abbrev-ref HEAD)"
    if [[ "$active_branch" == "HEAD" ]]; then
      log_err "Repository is in detached HEAD state. Pass --branch <branch> or --skip-pull."
      exit 1
    fi
  fi

  local dirty_tracked
  dirty_tracked="$(git status --porcelain --untracked-files=no)"
  if [[ -n "$dirty_tracked" ]]; then
    if [[ "$STASH_LOCAL" == "true" ]]; then
      if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[dry-run] Would stash dirty tracked files before pulling '$active_branch'."
      else
        git stash push -m "smoker-update-${ts}" >/dev/null
        log_warn "Stashed local tracked changes as 'smoker-update-${ts}' (inspect with 'git stash list')."
      fi
    else
      log_err "Tracked files have uncommitted local modifications:"
      echo "$dirty_tracked" >&2
      log_err "Commit/discard changes or re-run with --stash or --skip-pull."
      exit 1
    fi
  fi

  local old_sha new_sha
  old_sha="$(git rev-parse --short HEAD)"
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would run: git fetch origin '${active_branch}' && git pull --ff-only origin '${active_branch}'"
    return
  fi

  log_info "Fetching and fast-forwarding '${active_branch}' from origin..."
  git fetch origin "${active_branch}"
  if ! git pull --ff-only origin "${active_branch}"; then
    log_err "Fast-forward pull failed (local branch diverged from origin/${active_branch}). Resolve manually or use --skip-pull."
    exit 1
  fi
  new_sha="$(git rev-parse --short HEAD)"

  if [[ "$old_sha" == "$new_sha" ]]; then
    log_info "Repository already at latest commit (${new_sha})."
  else
    log_info "Updated ${old_sha} -> ${new_sha}:"
    git --no-pager log --oneline -n 10 "${old_sha}..${new_sha}" || true
  fi

  local sh_file
  for sh_file in "${ROOT_DIR}/scripts/"*.sh; do
    if [[ -f "$sh_file" && ! -x "$sh_file" ]]; then
      chmod +x "$sh_file" 2>/dev/null || true
    fi
  done
}

backup_central_db() {
  local ts="$1"
  if [[ "$DO_BACKUP" != "true" ]]; then
    log_info "Skipping pre-update database backup (--no-backup enabled)."
    return
  fi
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'smoker-db'; then
    log_warn "Container 'smoker-db' is not running; skipping pg_dump backup."
    return
  fi

  local pg_db pg_user backup_dir backup_file
  pg_db="$(read_env_var "${ROOT_DIR}/.env" "POSTGRES_DB")"; pg_db="${pg_db:-smoker}"
  pg_user="$(read_env_var "${ROOT_DIR}/.env" "POSTGRES_USER")"; pg_user="${pg_user:-smoker}"
  backup_dir="${ROOT_DIR}/backups"
  backup_file="${backup_dir}/smoker-pre-update-${ts}.sql.gz"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would dump TimescaleDB (${pg_db}) -> ${backup_file} (keep latest ${BACKUP_KEEP})"
    return
  fi

  mkdir -p "${backup_dir}"
  chmod 700 "${backup_dir}"
  log_info "Backing up TimescaleDB (${pg_db}) to ${backup_file}..."
  if ! docker exec smoker-db pg_dump -U "${pg_user}" -d "${pg_db}" --no-owner --no-acl | gzip -c > "${backup_file}"; then
    rm -f "${backup_file}"
    log_err "Database backup failed; aborting update before restarting Central."
    exit 1
  fi
  if [[ ! -s "${backup_file}" ]] || ! gzip -t "${backup_file}" >/dev/null 2>&1; then
    rm -f "${backup_file}"
    log_err "Generated backup archive failed integrity verification."
    exit 1
  fi
  chmod 600 "${backup_file}"
  log_info "Database backup verified ($(du -h "${backup_file}" | awk '{print $1}'))."

  # Enforce retention count across smoker-pre-update-*.sql.gz
  local old_backups
  old_backups="$(ls -1t "${backup_dir}"/smoker-pre-update-*.sql.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" || true)"
  if [[ -n "$old_backups" ]]; then
    while IFS= read -r old_file; do
      [[ -n "$old_file" ]] && rm -f "$old_file"
    done <<< "$old_backups"
    log_info "Pruned older DB backups (retained latest ${BACKUP_KEEP})."
  fi
}

sync_proxy_and_profile() {
  local access_mode domain app_port template_file vhost_out tmp_out
  access_mode="$(read_env_var "${ROOT_DIR}/.env" "EXTERNAL_ACCESS_MODE")"
  domain="$(read_env_var "${ROOT_DIR}/.env" "DOMAIN")"; domain="${domain:-localhost}"
  app_port="$(read_env_var "${ROOT_DIR}/.env" "APP_PORT")"; app_port="${app_port:-8080}"

  if [[ "$access_mode" == "nginx" && -n "$domain" && "$domain" != "localhost" ]]; then
    template_file="${ROOT_DIR}/deploy/nginx/external-proxy.conf.template"
    vhost_out="${ROOT_DIR}/deploy/nginx/generated-${domain}.conf"
    if [[ -f "$template_file" ]]; then
      if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[dry-run] Would re-render Nginx vhost template -> ${vhost_out}"
      else
        tmp_out="$(mktemp)"
        sed -e "s|__DOMAIN__|${domain}|g" \
            -e "s|__UPSTREAM_ADDR__|127.0.0.1:${app_port}|g" \
            "$template_file" > "$tmp_out"
        if [[ -f "$vhost_out" ]] && cmp -s "$tmp_out" "$vhost_out"; then
          rm -f "$tmp_out"
        else
          mv "$tmp_out" "$vhost_out"
          chmod 644 "$vhost_out"
          log_warn "Updated ${vhost_out} — re-copy and reload host Nginx if needed:"
          log_warn "  sudo cp \"${vhost_out}\" /etc/nginx/sites-available/smoker.conf && sudo nginx -t && sudo systemctl reload nginx"
        fi
      fi
    fi
  fi
}

wait_central_healthy() {
  log_info "Waiting for Central /readyz and Web healthchecks..."
  local ready="false"
  for _ in $(seq 1 45); do
    if docker exec smoker-central wget -qO- http://127.0.0.1:8080/readyz >/dev/null 2>&1; then
      ready="true"
      break
    fi
    sleep 2
  done
  if [[ "$ready" != "true" ]]; then
    log_err "smoker-central failed /readyz within 90s; check 'docker compose logs central'."
    exit 1
  fi

  local web_health="unknown"
  for _ in $(seq 1 30); do
    web_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' smoker-web 2>/dev/null || echo "missing")"
    if [[ "$web_health" == "healthy" || "$web_health" == "running" ]]; then
      break
    fi
    sleep 2
  done
  if [[ "$web_health" != "healthy" && "$web_health" != "running" ]]; then
    log_err "smoker-web status is '${web_health}'; check 'docker compose logs web'."
    exit 1
  fi
  log_info "Central (/readyz) and Web (${web_health}) are healthy."
}

update_central() {
  local ts="$1"
  local access_mode
  access_mode="$(read_env_var "${ROOT_DIR}/.env" "EXTERNAL_ACCESS_MODE")"

  local -a profile_args=()
  if [[ "$access_mode" == "tunnel" ]] || docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'smoker-cloudflared'; then
    profile_args=(--profile tunnel)
  elif [[ "$access_mode" == "tls" ]] || docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'smoker-caddy'; then
    profile_args=(--profile tls)
  fi

  local -a build_flags=()
  if [[ "$NO_CACHE" == "true" ]]; then
    build_flags=(--no-cache)
  fi

  local -a target_services=()
  if [[ -n "$SERVICES_CSV" ]]; then
    IFS=',' read -r -a target_services <<< "$SERVICES_CSV"
  fi

  backup_central_db "$ts"
  sync_proxy_and_profile
  pre_build_cleanup

  local -a build_order=()
  if [[ ${#target_services[@]} -gt 0 ]]; then
    build_order=("${target_services[@]}")
  else
    build_order=(central probe-local web)
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would build sequentially (COMPOSE_BAKE=false): ${build_order[*]}"
    log_info "[dry-run] Would run: docker compose ${profile_args[*]:-} up -d --no-build ${target_services[*]:-}"
    return
  fi

  export COMPOSE_BAKE=false
  local svc
  for svc in "${build_order[@]}"; do
    log_info "Building service '${svc}' sequentially..."
    docker compose ${profile_args[@]+"${profile_args[@]}"} build ${build_flags[@]+"${build_flags[@]}"} "$svc"
    if [[ "$DO_PRUNE" == "true" ]]; then
      docker image prune -f >/dev/null 2>&1 || true
    fi
  done

  log_info "Updating and starting Central containers..."
  docker compose ${profile_args[@]+"${profile_args[@]}"} up -d --no-build ${target_services[@]+"${target_services[@]}"}

  wait_central_healthy
}

update_probe() {
  local -a probe_files=()
  local pfile
  while IFS= read -r pfile; do
    [[ -n "$pfile" ]] && probe_files+=("$pfile")
  done < <(list_probe_env_files)

  if [[ ${#probe_files[@]} -eq 0 ]]; then
    if [[ -n "$INSTANCE_FILTER" ]]; then
      log_err "No env file found for probe instance '${INSTANCE_FILTER}'."
    else
      log_err "Missing .probe.env (or .probe.<instance>.env) for Remote Probe role. Run './scripts/setup.sh --role probe' first."
    fi
    exit 1
  fi

  local -a build_flags=()
  if [[ "$NO_CACHE" == "true" ]]; then
    build_flags=(--no-cache)
  fi

  pre_build_cleanup

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would build shared smoker-probe:latest image and restart ${#probe_files[@]} instance(s): ${probe_files[*]}"
    return
  fi

  export COMPOSE_BAKE=false
  log_info "Building shared Remote Probe image (smoker-probe:latest)..."
  docker compose -f "${ROOT_DIR}/deploy/docker/probe-agent.compose.yml" --env-file "${probe_files[0]}" build ${build_flags[@]+"${build_flags[@]}"}

  local pbase inst_name cname macvlan_net compose_file
  for pfile in "${probe_files[@]}"; do
    pbase="$(basename "$pfile")"
    cname="$(read_env_var "$pfile" "PROBE_CONTAINER_NAME")"
    macvlan_net="$(read_env_var "$pfile" "PROBE_MACVLAN_NET")"

    local -a project_args=()
    if [[ "$pbase" =~ ^\.probe\.(.+)\.env$ ]]; then
      inst_name="${BASH_REMATCH[1]}"
      cname="${cname:-smoker-probe-${inst_name}}"
      project_args=(-p "smoker-probe-${inst_name}")
    else
      cname="${cname:-smoker-probe}"
    fi

    if [[ -n "$macvlan_net" ]]; then
      compose_file="${ROOT_DIR}/deploy/docker/probe-macvlan.compose.yml"
    else
      compose_file="${ROOT_DIR}/deploy/docker/probe-agent.compose.yml"
    fi

    log_info "Restarting '${cname}' (${pbase}, preserving SQLite WAL buffer)..."
    docker compose ${project_args[@]+"${project_args[@]}"} -f "$compose_file" --env-file "$pfile" up -d --no-build
    sleep 2
    docker logs --tail=5 "$cname" || true
  done
}

get_free_mb() {
  local target_dir="/var/lib/docker"
  if [[ ! -d "$target_dir" ]]; then
    target_dir="${ROOT_DIR}"
  fi
  df -Pm "$target_dir" 2>/dev/null | awk 'NR==2 {print $4}' || echo "0"
}

pre_build_cleanup() {
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would check free disk space and prune stale Docker images/cache before building."
    return
  fi

  local free_mb
  free_mb="$(get_free_mb)"
  log_info "Available disk before build: ${free_mb} MB"

  if [[ "$DO_PRUNE" == "true" ]]; then
    log_info "Pruning dangling images & old build cache before building..."
    docker image prune -f >/dev/null 2>&1 || true
    docker builder prune -f --filter "until=1h" >/dev/null 2>&1 || true
    free_mb="$(get_free_mb)"
    if [[ "$free_mb" =~ ^[0-9]+$ ]] && [[ "$free_mb" -lt 2560 ]]; then
      log_warn "Free disk tight (${free_mb} MB < 2560 MB); clearing unused BuildKit cache (docker builder prune -af)..."
      docker builder prune -af >/dev/null 2>&1 || true
      free_mb="$(get_free_mb)"
    fi
    log_info "Available disk after pre-clean: ${free_mb} MB"
  fi

  if [[ "$free_mb" =~ ^[0-9]+$ ]] && [[ "$free_mb" -lt 1024 ]]; then
    log_err "Insufficient disk space (${free_mb} MB free; require >= 1024 MB to build containers)."
    df -h || true
    docker system df || true
    exit 1
  fi
}

prune_images() {
  if [[ "$DO_PRUNE" != "true" ]]; then
    log_info "Skipping dangling image prune (--no-prune enabled)."
    return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[dry-run] Would run: docker image prune -f && docker builder prune -f --filter until=1h"
    return
  fi
  log_info "Cleaning up dangling Docker images and expired build cache..."
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter "until=1h" >/dev/null 2>&1 || true
}

main() {
  local ts detected_role
  ts="$(date -u +"%Y%m%d-%H%M%S")"

  check_docker
  detected_role="$(detect_roles)"
  log_info "Detected deployment role: ${detected_role}"

  backup_env_files "$ts"
  pull_updates "$ts"

  case "$detected_role" in
    central)
      update_central "$ts"
      ;;
    probe)
      update_probe
      ;;
    all)
      update_central "$ts"
      update_probe
      ;;
  esac

  prune_images

  echo ""
  echo "==================== SMOKER UPDATE COMPLETE ===================="
  echo "Role      : ${detected_role}"
  echo "Commit    : $(git rev-parse --short HEAD 2>/dev/null || echo 'non-git')"
  if [[ "$DRY_RUN" != "true" ]]; then
    docker ps --filter "name=smoker" --format "table {{.Names}}\t{{.Status}}"
  else
    echo "Status    : Dry run completed (no changes applied)"
  fi
  echo "================================================================"
}

main
