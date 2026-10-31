#!/usr/bin/env bash
# Builds the SUT image, brings the hermetic stack up, drives the API-key CLI,
# runs the black-box suite inside the compose network and tears it all down.
# Extra args go to `bun test`:
#
#   e2e/run.sh                         # everything
#   e2e/run.sh tests/cluster.test.ts   # one file
#   e2e/run.sh -t 'admin guard'        # by test name
#   E2E_KEEP=1 e2e/run.sh              # leave the stack up to poke at it
#   E2E_SKIP_BUILD=1 e2e/run.sh        # reuse the image from the last run
set -euo pipefail

E2E=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$E2E/.." && pwd)
export E2E_UID=$(id -u) E2E_GID=$(id -g)
export E2E_SUT_IMAGE=${E2E_SUT_IMAGE:-baileys-api-e2e/sut:dev}

compose() { docker compose -f "$E2E/compose.yaml" "$@"; }
say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

if [ -z "${E2E_SKIP_BUILD:-}" ]; then
  say "build sut ($(git -C "$REPO" rev-parse --short HEAD))"
  docker build -q -t "$E2E_SUT_IMAGE" "$REPO" >/dev/null
fi

cleanup() {
  status=$?
  if [ $status -ne 0 ]; then
    mkdir -p "$E2E/logs"
    for s in baileys proxy worker-1 worker-2 redis redis-cluster; do
      compose logs --no-color "$s" > "$E2E/logs/$s.log" 2>&1 || true
    done
    echo "service logs in e2e/logs/"
  fi
  [ -n "${E2E_KEEP:-}" ] || compose --profile test down -v --remove-orphans >/dev/null 2>&1
  exit $status
}
trap cleanup EXIT

say "up"
compose --profile test down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d --wait

# --- API key admin CLI (bun manage-api-keys), driven as an operator would ---
say "manage-api-keys"
cli() { compose exec -T "$1" bun manage-api-keys "${@:2}" 2>&1; }
expect_out() { # <output> <fixed string> [absent]
  if [ "${3:-}" = absent ]; then
    ! grep -qF -- "$2" <<<"$1" && return
    printf 'manage-api-keys: did not expect %q in:\n%s\n' "$2" "$1"
  else
    grep -qF -- "$2" <<<"$1" && return
    printf 'manage-api-keys: expected %q in:\n%s\n' "$2" "$1"
  fi
  exit 1
}

expect_out "$(cli baileys)" "Usage:"
expect_out "$(cli baileys list)" "No API keys found."
for svc in baileys proxy; do # the cluster has its own Redis
  expect_out "$(cli $svc create user e2e-user-key)" "Created API key with role 'user': e2e-user-key"
  expect_out "$(cli $svc create user e2e-user2-key)" "Created API key with role 'user': e2e-user2-key"
  expect_out "$(cli $svc create admin e2e-admin-key)" "Created API key with role 'admin': e2e-admin-key"
done

out=$(cli baileys create admin)
generated=$(sed -n "s/^Created API key with role 'admin': \([0-9a-f]\{48\}\)$/\1/p" <<<"$out")
[ -n "$generated" ] || expect_out "$out" "a generated 48-hex-char admin key"
expect_out "$(cli baileys delete "$generated")" "API key deleted: $generated"
expect_out "$(cli baileys delete "$generated")" "API key not found: $generated"

# Revoked before any instance could cache it; the suite asserts it gets 401.
expect_out "$(cli baileys create user e2e-revoked-key)" "Created API key with role 'user': e2e-revoked-key"
expect_out "$(cli baileys delete e2e-revoked-key)" "API key deleted: e2e-revoked-key"

out=$(cli baileys list)
expect_out "$out" "Found 3 API keys"
expect_out "$out" '- e2e-user-key: {"role":"user"}'
expect_out "$out" '- e2e-admin-key: {"role":"admin"}'
expect_out "$out" "e2e-revoked-key" absent
echo "ok"

say "bun test $*"
compose --profile test run --rm --no-deps tests bun test "$@"
