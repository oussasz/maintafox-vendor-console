#!/bin/sh
# Starts, for the CI tests, the public media route in front of the CI Garage: the nginx image of
# the `edge` service in docker-compose.yml with the production rules (deploy/nginx-media-proxy.conf)
# and ci-media-proxy.nginx.conf. Listens on 127.0.0.1:3980 (TEST_S3_PUBLIC_ENDPOINT).
# Run after ci-start-garage.sh.
#
#   sh deploy/object-storage/ci-start-media-proxy.sh
#
# Checks the configuration first (nginx -t), then waits until the route answers; prints the
# container log and fails otherwise.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
image=$(awk '/^  edge:/{e=1} e && /^ +image: /{print $2; exit}' "$here/../../docker-compose.yml")
[ -n "$image" ] || { echo "no image found for the edge service in docker-compose.yml" >&2; exit 1; }
mounts="-v $here/ci-media-proxy.nginx.conf:/etc/nginx/conf.d/default.conf:ro -v $here/../nginx-media-proxy.conf:/etc/nginx/snippets/media-proxy.conf:ro"
# shellcheck disable=SC2086
docker run --rm --network host $mounts "$image" nginx -t
# shellcheck disable=SC2086
docker run -d --name mfx-ci-media-proxy --network host $mounts "$image" > /dev/null
for _ in $(seq 1 30); do
  # An unsigned request is refused by the route itself: 403 means nginx is up with these rules.
  if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3980/ || true)" = "403" ]; then
    echo "Media route ready: $image on 127.0.0.1:3980"
    exit 0
  fi
  sleep 1
done
docker logs mfx-ci-media-proxy
echo "media route did not become ready" >&2
exit 1
