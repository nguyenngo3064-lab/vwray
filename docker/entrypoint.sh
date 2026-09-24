#!/bin/sh
#
# VWRAY control-plane container entrypoint.
#
# Order of operations:
#   1. If a command was provided that is not the default server command, exec it
#      immediately (administration/debug path, e.g. `docker run --rm IMAGE sh`).
#      No configuration is validated there, because a diagnosis container must
#      work even when the application configuration is what is broken.
#   2. Validate the values the process cannot start without.
#   3. Optionally wait for PostgreSQL to accept TCP connections.
#   4. Optionally apply committed migrations with `prisma migrate deploy`.
#   5. `exec node server.js` so the Next.js server becomes PID 1 and receives
#      SIGTERM directly (the platform's graceful-shutdown window is finite).
#
# Knobs (all optional, defaults chosen for a single-replica service):
#   RUN_MIGRATIONS_ON_START=true|false   default true
#       Run `prisma migrate deploy` before the server starts. Set it to false and
#       run `docker compose run --rm migrate` (or a Railway/Render pre-deploy
#       command) instead when migrations must happen exactly once per release, for
#       example with several replicas.
#   DB_WAIT_TIMEOUT_SECONDS=60           default 60
#       How long to poll the database host before giving up on migrations.
#   MIGRATE_MAX_ATTEMPTS=3               default 3
#       Attempts for `migrate deploy` (each attempt re-runs after a delay, which
#       covers a primary that is still finishing its own startup).
#   MIGRATE_RETRY_DELAY_SECONDS=5         default 5
#   PORT / HOSTNAME                      default 3000 / 0.0.0.0
#
# Failure policy (documented in docs/OPERATIONS.md):
#   * Migrations enabled and unapplied -> exit non-zero. Serving traffic against a
#     schema that could not be verified is worse than a visible crash loop.
#   * Migrations disabled -> start even when the database is down, so that
#     GET /api/health can report the outage and recovery needs no intervention.
#
# This script is POSIX sh (Alpine has no bash) and is intentionally dependency-free:
# the only tool it needs is `node`, which is the image's whole purpose.
set -eu

log() { printf '%s [entrypoint] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  printf '%s [entrypoint] FATAL: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit 1
}

RUN_MIGRATIONS_ON_START="${RUN_MIGRATIONS_ON_START:-true}"
DB_WAIT_TIMEOUT_SECONDS="${DB_WAIT_TIMEOUT_SECONDS:-60}"
MIGRATE_MAX_ATTEMPTS="${MIGRATE_MAX_ATTEMPTS:-3}"
MIGRATE_RETRY_DELAY_SECONDS="${MIGRATE_RETRY_DELAY_SECONDS:-5}"
PRISMA_CLI="${PRISMA_CLI:-./node_modules/prisma/build/index.js}"
PORT="${PORT:-3000}"
HOSTNAME="${HOSTNAME:-0.0.0.0}"
export PORT HOSTNAME

# ---- 1. command override -----------------------------------------------------
if [ "$#" -gt 0 ] && [ "$1" != "node" ]; then
  log "Running the supplied command instead of the server: $*"
  exec "$@"
fi

# The image CMD is `node server.js`; fall back to it when ran with no arguments.
if [ "$#" -eq 0 ]; then
  set -- node server.js
fi

# ---- 2. configuration that has no safe default -------------------------------
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set. See .env.example; there is no default."

case "$RUN_MIGRATIONS_ON_START" in
  true | false | 1 | 0 | yes | no) : ;;
  *) die "RUN_MIGRATIONS_ON_START must be true or false (got '$RUN_MIGRATIONS_ON_START')." ;;
esac

# The application validates its environment lazily, at request time, so a missing
# secret would otherwise surface as a 500 on the first login. These two checks
# mirror the contract in src/server/config/env.ts (length only - the KDF and key
# handling stay in the application).
[ -n "${AUTH_SECRET:-}" ] || die "AUTH_SECRET is not set. Generate one with: openssl rand -base64 48"
[ "${#AUTH_SECRET}" -ge 32 ] || die "AUTH_SECRET must be at least 32 characters."
[ -n "${ENCRYPTION_KEY:-}" ] || die "ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32"
[ "${#ENCRYPTION_KEY}" -ge 24 ] || die "ENCRYPTION_KEY must be at least 24 characters (32 base64 bytes)."

if [ "$RUN_MIGRATIONS_ON_START" = "true" ] || [ "$RUN_MIGRATIONS_ON_START" = "1" ] || [ "$RUN_MIGRATIONS_ON_START" = "yes" ]; then
  log "Applying database migrations"
  "$PRISMA_CLI" migrate deploy
fi

exec "$@"
