#!/usr/bin/env bash
# Idempotent VPS security maintenance for Maintafox control-plane hosts.
# Run on the server as root: bash deploy/vps-security-maintenance.sh [--reboot]
set -euo pipefail

REBOOT=false
COMPOSE_DIR="${COMPOSE_DIR:-/opt/maintafox-vendor-console}"

for arg in "$@"; do
  case "$arg" in
    --reboot) REBOOT=true ;;
    -h|--help)
      echo "Usage: $0 [--reboot]"
      echo "  Applies OS updates, enables unattended security upgrades, refreshes Docker edge,"
      echo "  hardens SSH config, and verifies HTTPS health. Reboot only with --reboot."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

log() { printf '[maintafox-security] %s\n' "$*"; }

log "Starting security maintenance in ${COMPOSE_DIR}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' full-upgrade
apt-get -y autoremove --purge

cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

unattended-upgrades --dry-run >/dev/null 2>&1 || true

if command -v docker >/dev/null 2>&1; then
  systemctl restart docker
  sleep 2
  if [[ -d "${COMPOSE_DIR}" && -f "${COMPOSE_DIR}/docker-compose.yml" ]]; then
  (
    cd "${COMPOSE_DIR}"
    docker compose pull edge || true
    docker compose --env-file .env up -d || docker compose up -d
    docker compose up -d --force-recreate edge || true
  )
  fi
fi

if [[ -f /etc/ssh/sshd_config.d/50-cloud-init.conf ]]; then
  cp -a /etc/ssh/sshd_config.d/50-cloud-init.conf /etc/ssh/sshd_config.d/50-cloud-init.conf.bak
  sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/50-cloud-init.conf
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi

log "Verification"
systemctl is-active docker fail2ban ufw
curl -sf https://api.maintafox.systems/health >/dev/null
# Headers first, then search: with pipefail, `curl | grep -q` can fail when grep stops early (SIGPIPE).
http_headers=$(curl -sI http://api.maintafox.systems/health)
grep -qi 'location: https://' <<< "$http_headers"
if [[ -d "${COMPOSE_DIR}" ]]; then
  docker compose -f "${COMPOSE_DIR}/docker-compose.yml" ps
fi
apt list --upgradable 2>/dev/null | grep -c noble-security || true

if [[ "${REBOOT}" == true ]]; then
  if [[ -f /var/run/reboot-required ]] || [[ "$(uname -r)" != "$(ls -t /boot/vmlinuz-* 2>/dev/null | head -1 | sed 's|.*/vmlinuz-||')" ]]; then
    log "Rebooting for new kernel..."
    reboot
  else
    log "No reboot required."
  fi
else
  log "Done. Re-run with --reboot if a new kernel was installed."
fi
