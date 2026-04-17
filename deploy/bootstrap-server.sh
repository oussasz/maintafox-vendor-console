#!/usr/bin/env bash
# Run on the VPS after copying the repo to e.g. /opt/maintafox-vendor-console
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker.io docker-compose-plugin
  systemctl enable --now docker
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env — edit JWT_SECRET, SEED_ADMIN_PASSWORD, then run:"
  echo "  docker compose --env-file .env up -d --build"
  echo "See deploy/VPS-COMMANDS.md"
  exit 0
fi

docker compose --env-file .env up -d --build
echo "Edge: http://$(hostname -I | awk '{print $1}') (port 80) — use DNS console.maintafox.systems + api.maintafox.systems"
echo "See deploy/VPS-COMMANDS.md for HTTPS"
