#!/bin/sh
set -eu

if [ "${MIGRATE_ON_START:-true}" = "true" ]; then
  node /app/.output/migrate.mjs
fi

exec "$@"
