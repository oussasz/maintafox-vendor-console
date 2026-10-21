#!/bin/sh
# Starts the object store for the CI tests exactly as production runs it: the Garage image pinned
# (by digest) in docker-compose.yml, the production deploy/object-storage/garage.toml, and
# `--single-node --default-bucket` creating the access key. Listens on 127.0.0.1:3900.
#
#   TEST_S3_ACCESS_KEY=... TEST_S3_SECRET_KEY=... sh deploy/object-storage/ci-start-garage.sh
#
# Waits until `garage status` answers (the key and the default bucket exist by then); prints the
# container log and fails otherwise. The key may also create buckets (each test uses its own).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${TEST_S3_ACCESS_KEY:?TEST_S3_ACCESS_KEY is required}"
: "${TEST_S3_SECRET_KEY:?TEST_S3_SECRET_KEY is required}"
image=$(grep -E '^ +image: dxflrs/garage:' "$here/../../docker-compose.yml" | awk '{print $2}')
case "$image" in
  *@sha256:*) ;;
  *) echo "the Garage image in docker-compose.yml must be pinned by digest, got '$image'" >&2; exit 1 ;;
esac
docker run -d --name mfx-ci-garage -p 127.0.0.1:3900:3900 \
  -v "$here/garage.toml:/etc/garage.toml:ro" \
  -e GARAGE_RPC_SECRET="$(openssl rand -hex 32)" \
  -e GARAGE_DEFAULT_ACCESS_KEY="$TEST_S3_ACCESS_KEY" \
  -e GARAGE_DEFAULT_SECRET_KEY="$TEST_S3_SECRET_KEY" \
  -e GARAGE_DEFAULT_BUCKET=mfx-ci-default \
  "$image" /garage server --single-node --default-bucket > /dev/null
for _ in $(seq 1 60); do
  if docker exec mfx-ci-garage /garage status > /dev/null 2>&1; then
    echo "Garage ready: $image"
    exit 0
  fi
  sleep 1
done
docker logs mfx-ci-garage
echo "Garage did not become ready" >&2
exit 1
