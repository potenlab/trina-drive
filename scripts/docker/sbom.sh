#!/usr/bin/env bash
# SBOM of the image (docs/DOCKER.md, "Supply chain"): every Debian package, the npm packages under /app/node_modules
# and the binaries syft recognises (bun, rg), in SPDX and CycloneDX JSON, plus a short summary. Runs syft from its own
# digest-pinned image against `docker save` of the image, so nothing is installed on the host and no registry is used.
#
#   scripts/docker/sbom.sh [image]        (default trina-drive:dev) -> dist/sbom/<name>-<version>.{spdx,cdx}.json
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME=$(sed -n 's/^  "name": "\(.*\)",$/\1/p' package.json)
IMAGE=${1:-$NAME:dev}
SYFT=anchore/syft:v1.54.1@sha256:3eb5379ba7b409c3f4069b686110527af0c47df993fa5c10d13e7cf34f49b1aa
VERSION=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE")
OUT=dist/sbom
mkdir -p "$OUT"
docker save "$IMAGE" -o "$OUT/image.tar"
trap 'rm -f "$OUT/image.tar"' EXIT
docker run --rm -v "$PWD/$OUT:/work" "$SYFT" scan "docker-archive:/work/image.tar" -q \
  -o "spdx-json=/work/$NAME-$VERSION.spdx.json" -o "cyclonedx-json=/work/$NAME-$VERSION.cdx.json" -o "syft-table=/work/$NAME-$VERSION.txt"
echo "$OUT/$NAME-$VERSION.spdx.json  $OUT/$NAME-$VERSION.cdx.json  ($(grep -c . "$OUT/$NAME-$VERSION.txt") lines in $OUT/$NAME-$VERSION.txt)"
grep -E '^(NAME|bubblewrap|poppler-utils|libpoppler|tini|bun|ripgrep|just-bash|libc6) ' "$OUT/$NAME-$VERSION.txt" || true
