#!/usr/bin/env bash
# Local Trina Cloud on this machine's Docker engine (colima, Docker Desktop or Linux): the control plane, Caddy with
# self-signed TLS on https://*.cloud.localhost:8443, and two teams (acme, globex) provisioned the real way — sign-up,
# a signed Paddle webhook, the emailed setup link — then the end-to-end checks (cloud/dev/e2e.ts).
#
#   cloud/dev/up.sh                 clean start: build images if missing, start, provision two teams, run the checks
#   cloud/dev/up.sh --no-teams      only the control plane and Caddy
#   cloud/dev/up.sh --rebuild       rebuild the three images first
#   cloud/dev/up.sh --phase1        then the Trina Cloud v1 Phase 1 scenarios (cloud/dev/e2e/run.ts --phase 1; with
#                                   --no-teams they run on a fresh stack without the legacy checks)
#   cloud/dev/down.sh               remove everything (teams, volumes, state)
#
# Then: https://cloud.localhost:8443 (sign up; mail goes to cloud/dev/.state/outbox.log, the teams' own mail to
# cloud/dev/.state/team-mail.log through the relay), https://acme.cloud.localhost:8443
# (trust cloud/dev/.state/caddy-root.crt in your browser, or accept the warning). No cloud account, nothing leaves the machine.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
DEV=$ROOT/cloud/dev
STATE=$DEV/.state
TEAMS=1 REBUILD=0 PHASE1=0
for a in "$@"; do
  case $a in
    --no-teams) TEAMS=0 ;;
    --rebuild) REBUILD=1 ;;
    --phase1) PHASE1=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
: "${TDCLOUD_IMAGE:=trina-drive:cloud-dev}"
: "${TDCLOUD_PUBLIC_PORT:=8443}"
TDCLOUD_DOMAIN=cloud.localhost

say() { printf '\n== %s\n' "$*"; }
command -v docker >/dev/null || { echo "needs docker" >&2; exit 2; }
command -v bun >/dev/null || { echo "needs bun (https://bun.sh)" >&2; exit 2; }

# ---- images
build() { # tag, then docker build args
  local tag=$1; shift
  if [ $REBUILD = 1 ] || ! docker image inspect "$tag" >/dev/null 2>&1; then
    say "build $tag"; docker build -q -t "$tag" "$@" >/dev/null
  fi
}
build "$TDCLOUD_IMAGE" "$ROOT"
build tdcloud-control:dev --target dev "$ROOT/cloud/control"
build tdcloud-caddy:dev "$ROOT/cloud/caddy"

# ---- AppArmor: team containers use the trina-drive-bwrap profile (docs/DOCKER.md §3)
APPARMOR=trina-drive-bwrap
if docker info --format '{{.SecurityOptions}}' | grep -q apparmor; then
  if ! docker run --rm --security-opt "apparmor=$APPARMOR" --entrypoint /bin/true "$TDCLOUD_IMAGE" >/dev/null 2>&1; then
    say "loading the AppArmor profile $APPARMOR into the Docker host"
    if command -v colima >/dev/null && colima status >/dev/null 2>&1; then
      colima ssh -- sudo apparmor_parser -r /dev/stdin < "$ROOT/docker/apparmor-trina-drive-bwrap"
    elif [ "$(uname)" = Linux ]; then
      sudo apparmor_parser -r "$ROOT/docker/apparmor-trina-drive-bwrap"
    else
      echo "load docker/apparmor-trina-drive-bwrap on the Docker host (apparmor_parser -r), then run again" >&2; exit 2
    fi
  fi
else
  APPARMOR=
fi

# ---- clean start
"$DEV/down.sh" --quiet
mkdir -p "$STATE" && chmod 700 "$STATE"
rand() { bun -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"; }
umask 077
cat > "$STATE/dev.env" <<EOF
TDCLOUD_STATE_DIR=$STATE
TDCLOUD_DOMAIN=$TDCLOUD_DOMAIN
TDCLOUD_SLUG_LABEL=$(awk -F. '{print NF}' <<<"$TDCLOUD_DOMAIN")
TDCLOUD_PUBLIC_PORT=$TDCLOUD_PUBLIC_PORT
TDCLOUD_IMAGE=$TDCLOUD_IMAGE
TDCLOUD_APPARMOR=$APPARMOR
TDCLOUD_CADDY_ASK_KEY=$(rand)
PADDLE_WEBHOOK_SECRET=pdl_ntfset_dev_$(rand)
TDCLOUD_TEAM_MAIL_FROM=Trina Drive (dev) <drive@trina.test>
EOF
umask 022

say "start control plane + Caddy + mail relay"
docker compose --env-file "$STATE/dev.env" -f "$DEV/compose.yml" up -d --quiet-pull 2>&1 | grep -v '^ *$' || true
for _ in $(seq 60); do
  docker exec tdc-control bun -e "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null && break
  sleep 1
done
for _ in $(seq 30); do
  docker exec tdc-mail bun -e "fetch('http://127.0.0.1:8025/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null && break
  sleep 1
done
# Caddy's local CA (made when it issued https://cloud.localhost's certificate)
for _ in $(seq 30); do
  docker exec tdc-caddy cat /data/caddy/pki/authorities/local/root.crt > "$STATE/caddy-root.crt" 2>/dev/null && [ -s "$STATE/caddy-root.crt" ] && break
  sleep 1
done
for _ in $(seq 30); do
  curl -sf --cacert "$STATE/caddy-root.crt" --resolve "$TDCLOUD_DOMAIN:$TDCLOUD_PUBLIC_PORT:127.0.0.1" -o /dev/null "https://$TDCLOUD_DOMAIN:$TDCLOUD_PUBLIC_PORT/healthz" 2>/dev/null && break
  sleep 1
done
curl -sS --cacert "$STATE/caddy-root.crt" --resolve "$TDCLOUD_DOMAIN:$TDCLOUD_PUBLIC_PORT:127.0.0.1" -o /dev/null -w '  control plane: https://%{url.host}:%{url.port} → %{http_code}\n' "https://$TDCLOUD_DOMAIN:$TDCLOUD_PUBLIC_PORT/healthz"

if [ $TEAMS = 1 ]; then
  say "provision two teams and run the end-to-end checks"
  bun "$DEV/e2e.ts"
fi
if [ $PHASE1 = 1 ]; then
  say "Trina Cloud v1 Phase 1 scenarios"
  bun "$DEV/e2e/run.ts" --phase 1
fi

cat <<EOF

Trina Cloud (local) is up.
  control plane   https://$TDCLOUD_DOMAIN:$TDCLOUD_PUBLIC_PORT        (mail: $STATE/outbox.log)
  team mail       $STATE/team-mail.log  (invites, resets: through the relay tdc-mail)
  teams           https://<slug>.$TDCLOUD_DOMAIN:$TDCLOUD_PUBLIC_PORT
  TLS root        $STATE/caddy-root.crt
  admin CLI       docker exec tdc-control bun /app/src/main.ts teams list
  stop            cloud/dev/down.sh
EOF
