#!/bin/sh
# Oil Center entrypoint. The image starts as root ONLY so it can hand the persistent volume to an
# unprivileged user; everything after this script runs as `node` (uid 1000).
#
# Why not `USER node` in the Dockerfile alone: hosts mount /app/data root-owned (Railway's volumes do),
# and a non-root process cannot chown it — first boot would fail on the very first database write.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # chown only walks the tree (no data rewrite); on the following boots it finds node-owned files and is quick.
  chown -R node:node "$DATA_DIR"
  exec gosu node:node "$0" "$@"
fi

exec "$@"
