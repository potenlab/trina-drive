#!/usr/bin/env bash
# Builds the image, runs it the way docker-compose.yml does with demo data, checks it end to end, then runs the whole
# test suite inside the test image under the same security settings. Needs a Linux Docker host (or colima / Docker
# Desktop) and, on an AppArmor host, the profile docker/apparmor-trina-drive-bwrap loaded (the script says how if not).
#
#   scripts/docker-test.sh                 # everything
#   scripts/docker-test.sh --smoke-only    # build + smoke, no test suite
#   scripts/docker-test.sh --tests-only    # build the test image + test suite
#   scripts/docker-test.sh --no-build      # use the images already built (trina-drive:dev, trina-drive:test)
#   IMAGE=trina-drive:dev TEST_IMAGE=trina-drive:test APPARMOR=trina-drive-bwrap scripts/docker-test.sh
#
# Smoke: /health, the web app (200), MCP initialize + tools/list, the bash tool as kim (`ls /`: no 경영; `ls /경영` and
# grep for 매출 find nothing of 경영), as boss (경영 visible, a PDF read through pdftotext in a worker), the start-up line
# "worker isolation: bwrap"; then the same image under Docker's DEFAULT security settings must start, print the
# start-up error that points to the compose settings, and refuse shell commands and document extraction.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
NAME=$(sed -n 's/^  "name": "\(.*\)",$/\1/p' package.json)
IMAGE=${IMAGE:-$NAME:dev}
TEST_IMAGE=${TEST_IMAGE:-$NAME:test}
APPARMOR=${APPARMOR:-$NAME-bwrap}
SMOKE=1 TESTS=1 BUILD=1
for a in "$@"; do
  case $a in
    --smoke-only) TESTS=0 ;;
    --tests-only) SMOKE=0 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

P=$NAME-smoke-$$
TMP=$(mktemp -d)
cleanup() {
  docker compose -p "$P" -f docker-compose.yml -f "$TMP/override.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$P-default" >/dev/null 2>&1 || true
  docker volume rm -f "$P-default" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

t0=$SECONDS
step() { printf '\n== %s (%ss)\n' "$*" $((SECONDS - t0)); }
ok() { printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*" >&2; FAILED=$((FAILED + 1)); }
FAILED=0
check() { local what=$1; shift; if "$@"; then ok "$what"; else fail "$what"; fi; }
has() { grep -qF -- "$2" <<<"$1"; }
hasnt() { ! grep -qF -- "$2" <<<"$1"; }

# --- security settings (the same as docker-compose.yml) ---
SEC=(--read-only --cap-drop ALL --security-opt no-new-privileges:true
     --security-opt "seccomp=$ROOT/docker/seccomp-bwrap.json" --security-opt systempaths=unconfined)
if docker info --format '{{.SecurityOptions}}' | grep -q apparmor; then
  SEC+=(--security-opt "apparmor=$APPARMOR")
  APPARMOR_HOST=1
else
  APPARMOR_HOST=0
fi

if [ $BUILD = 1 ]; then
  rev=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  args=(--build-arg "REVISION=$rev" --build-arg "CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)" --build-arg "VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)")
  if [ $SMOKE = 1 ]; then
    step "build $IMAGE"; s=$SECONDS
    docker build -q "${args[@]}" -t "$IMAGE" . >/dev/null
    echo "  built in $((SECONDS - s)) s; image $(docker image inspect -f '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1e6}') (compressed layers)"
  fi
  if [ $TESTS = 1 ]; then
    step "build $TEST_IMAGE (--target test)"; s=$SECONDS
    docker build -q "${args[@]}" --target test -t "$TEST_IMAGE" . >/dev/null
    echo "  built in $((SECONDS - s)) s"
  fi
fi

probe_image=$IMAGE; [ $SMOKE = 1 ] || probe_image=$TEST_IMAGE
if [ "$APPARMOR_HOST" = 1 ] && ! docker run --rm --security-opt "apparmor=$APPARMOR" --entrypoint /bin/true "$probe_image" >/dev/null 2>&1; then
  echo "This Docker host uses AppArmor and the profile $APPARMOR is not loaded. Load it once (as root on the Docker host):" >&2
  echo "  sudo apparmor_parser -r docker/apparmor-$NAME-bwrap      # colima: colima ssh -- sudo apparmor_parser -r < docker/apparmor-$NAME-bwrap" >&2
  exit 1
fi

mcp() { # token, json-rpc body
  curl -sS --max-time 30 "$BASE/mcp" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$2"
}
bash_tool() { # token, command -> structuredContent JSON
  mcp "$1" "$(jq -nc --arg c "$2" '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"bash",arguments:{command:$c}}}')" | jq -c '.result.structuredContent // .'
}
command -v jq >/dev/null || { echo "needs jq" >&2; exit 2; }

if [ $SMOKE = 1 ]; then
  step "smoke: docker-compose.yml with demo data (project $P)"
  cat > "$TMP/override.yml" <<EOF
services:
  $NAME:
    image: $IMAGE
    ports: !override
      - "127.0.0.1::8787"
EOF
  [ "$APPARMOR_HOST" = 1 ] || printf '    security_opt: !override\n      - no-new-privileges:true\n      - seccomp=./docker/seccomp-bwrap.json\n      - systempaths=unconfined\n' >> "$TMP/override.yml"
  DC=(docker compose -p "$P" -f docker-compose.yml -f "$TMP/override.yml")
  s=$SECONDS
  seed=$("${DC[@]}" run --rm --no-deps "$NAME" demo seed 2>/dev/null)
  KIM=$(sed -n 's/^kim token: *//p' <<<"$seed"); BOSS=$(sed -n 's/^boss token: *//p' <<<"$seed")
  check "demo seed in the data volume ($((SECONDS - s)) s)" test -n "$KIM" -a -n "$BOSS"
  s=$SECONDS
  "${DC[@]}" up -d --no-build >/dev/null 2>&1
  C=$("${DC[@]}" ps -q "$NAME")
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$C")" = healthy ] || [ $((SECONDS - s)) -gt 90 ]; do sleep 1; done
  check "container healthy ($((SECONDS - s)) s after start)" test "$(docker inspect -f '{{.State.Health.Status}}' "$C")" = healthy
  BASE="http://$(docker port "$C" 8787/tcp | head -1)"
  logs=$(docker logs "$C" 2>&1)
  check "start-up log: worker isolation: bwrap" has "$logs" "worker isolation: bwrap"
  check "no start-up error" hasnt "$logs" "ERROR"
  check "runs as uid 10001, read-only root, no capabilities" test "$(docker exec "$C" sh -c 'id -u; touch /x 2>/dev/null && echo rw; grep CapEff /proc/1/status' | tr '\n' ' ')" = "10001 CapEff:	0000000000000000 "
  check "GET /health" has "$(curl -sS "$BASE/health")" '"ok":true'
  check "GET / (web app) 200" test "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/")" = 200
  init=$(mcp "$KIM" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"docker-test","version":"1"}}}')
  check "MCP initialize (kim)" has "$init" '"serverInfo":{"name":"'"$NAME"'"'
  check "MCP tools/list has bash" has "$(mcp "$KIM" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')" '"name":"bash"'
  s=$SECONDS; r=$(bash_tool "$KIM" 'ls /'); ms=$((SECONDS - s))
  check "kim: bash 'ls /' lists 공용 and 프로젝트 ($ms s)" has "$r" '공용\n프로젝트'
  check "kim: 'ls /' has no 경영" hasnt "$r" '경영'
  r=$(bash_tool "$KIM" 'ls /경영; grep -rl 매출 / ; echo done')
  check "kim: ls /경영 is 'No such file or directory'" has "$r" 'ls: /경영: No such file or directory'
  check "kim: grep -rl 매출 / finds nothing of 경영" hasnt "$r" '경영/'
  r=$(bash_tool "$KIM" 'cat /프로젝트/사양서.docx | head -1')
  check "kim: a docx read as text (extraction worker)" has "$r" '사양서'
  r=$(bash_tool "$BOSS" 'ls /; cat /경영/이사회_메모.pdf | head -2')
  check "boss: sees 경영 and reads a PDF through pdftotext in a worker" has "$r" 'Board memo'
  r=$(bash_tool "$KIM" 'cat /proc/self/environ; curl http://example.com; echo x > /공용/x')
  check "kim: no /proc of the server, no curl, originals read-only" has "$r" 'read-only'
  docker exec "$C" sh -c 'cd /app && sha256sum -c --quiet SHA256SUMS' >/dev/null && ok "/app matches its SHA256SUMS" || fail "/app SHA256SUMS"
  # the job dirs' tmpfs is noexec, and that holds inside the sandbox: a worker cannot run a program it wrote
  r=$(docker exec "$C" sh -c 'd=$(mktemp -d) && cp /usr/bin/true $d/t && bwrap --unshare-all --ro-bind /usr/lib /usr/lib --symlink usr/lib /lib --proc /proc --dev /dev --bind $d $d --remount-ro / $d/t; echo "exit=$?"; rm -rf $d' 2>&1)
  check "a program written to a job dir cannot run inside bwrap (noexec /tmp)" has "$r" "Permission denied"

  step "smoke: Docker's default security settings refuse shell and extraction, and say why"
  docker volume create "$P-default" >/dev/null
  docker run --rm -v "$P-default:/data" "$IMAGE" demo seed >/dev/null 2>&1
  seed=$(docker run --rm -v "$P-default:/data" "$IMAGE" token create kim 2>/dev/null)
  docker run -d --name "$P-default" -v "$P-default:/data" -p 127.0.0.1::8787 --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges:true "$IMAGE" serve --host 0.0.0.0 --port 8787 --no-reconcile >/dev/null
  s=$SECONDS; until curl -sf "http://$(docker port "$P-default" 8787/tcp | head -1)/health" >/dev/null 2>&1 || [ $((SECONDS - s)) -gt 60 ]; do sleep 1; done
  BASE="http://$(docker port "$P-default" 8787/tcp | head -1)"
  logs=$(docker logs "$P-default" 2>&1)
  check "start-up log: worker isolation: none" has "$logs" "worker isolation: none"
  check "start-up ERROR names the compose security settings" has "$logs" "ERROR: bash commands and document text extraction are refused"
  check "  ... and docs/DOCKER.md" has "$logs" 'seccomp=docker/seccomp-bwrap.json, apparmor='
  check "bash tool refused" has "$(bash_tool "$seed" 'ls /')" 'commands cannot run: the server has no isolated executor available'
  r=$(mcp "$seed" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read","arguments":{"path":"/프로젝트/사양서.docx"}}}')
  check "document extraction refused (read tool, docx)" has "$r" 'cannot extract text'
  docker rm -f "$P-default" >/dev/null
fi

if [ $TESTS = 1 ]; then
  # --timeout: the preload's setDefaultTimeout (test/setup.ts) does not reach every file of a full run in bun 1.3.12,
  # and a few suites take 5-10 s on a 4-CPU VM (they take 1-3 s natively). FUZZ_TEST_SECONDS: the fuzz test wants > 100
  # iterations; 8 s (its default) gave 96-110 on such a VM
  step "bun test inside $TEST_IMAGE (same security settings; /tmp may hold executable test stubs)"
  s=$SECONDS
  set +e
  docker run --rm "${SEC[@]}" --tmpfs /tmp:size=2g,mode=1777,nosuid,nodev,exec \
    -e TDRIVE_EXPECT_ISOLATION=bwrap -e TDRIVE_TEST_CANARY=canary-in-the-test-runner-environment -e FUZZ_TEST_SECONDS="${FUZZ_TEST_SECONDS:-16}" \
    "$TEST_IMAGE" bun test --timeout 30000 > "$TMP/test.log" 2>&1
  code=$?
  set -e
  grep -E '^\(fail\)|^ [0-9]+ (pass|fail|skip)$|^Ran ' "$TMP/test.log" | sort -u
  grep -E '^\[worker\] (isolation|bwrap|/proc|canary|network|spawn)' "$TMP/test.log" | sed 's/^/  /'
  echo "  bun test: exit $code in $((SECONDS - s)) s (log kept at ${KEEP_LOG:-$ROOT/dist/docker-test.log})"
  mkdir -p "$(dirname "${KEEP_LOG:-$ROOT/dist/docker-test.log}")"; cp "$TMP/test.log" "${KEEP_LOG:-$ROOT/dist/docker-test.log}"
  [ $code = 0 ] || FAILED=$((FAILED + 1))
fi

step "done"
[ $FAILED = 0 ] && echo "all checks passed" || { echo "$FAILED check(s) failed" >&2; exit 1; }
