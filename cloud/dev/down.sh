#!/usr/bin/env bash
# Removes the local Trina Cloud: team containers, networks and volumes (label tdcloud.team), the control plane, Caddy,
# the mail relay, and cloud/dev/.state. Touches nothing without the tdcloud label or outside the tdcloud-dev compose
# project.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
DEV=$PWD/cloud/dev
STATE=$DEV/.state
q() { [ "${1:-}" = --quiet ] || echo "$2"; }

ids=$(docker ps -aq --filter label=tdcloud.team)
[ -n "$ids" ] && docker rm -f $ids >/dev/null
for n in $(docker network ls -q --filter label=tdcloud.team); do
  docker network disconnect -f "$n" tdc-caddy >/dev/null 2>&1
  docker network rm "$n" >/dev/null 2>&1
done
if [ -f "$STATE/dev.env" ]; then
  docker compose --env-file "$STATE/dev.env" -f "$DEV/compose.yml" down -v --remove-orphans >/dev/null 2>&1
else
  docker rm -f tdc-control tdc-caddy tdc-mail >/dev/null 2>&1
  docker network rm tdc-control >/dev/null 2>&1
  docker volume rm tdcloud-dev_caddy-data tdcloud-dev_caddy-config >/dev/null 2>&1
fi
vols=$(docker volume ls -q --filter label=tdcloud.team)
[ -n "$vols" ] && docker volume rm -f $vols >/dev/null
if [ -d "$STATE" ]; then
  # backup staging is owned by the team uids inside the engine: remove it from a container
  docker run --rm -v "$STATE:/s" --entrypoint /bin/sh tdcloud-control:dev -c 'rm -rf /s/teams' >/dev/null 2>&1
  rm -rf "$STATE"
fi
q "${1:-}" "local Trina Cloud removed"
