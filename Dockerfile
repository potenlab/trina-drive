# syntax=docker/dockerfile:1.7
# The server for a Linux box (plan 5.2 "리눅스 Docker"; not for NAS-internal Docker, see docs/DOCKER.md).
#
#   docker build -t trina-drive:dev .                              # this machine's platform
#   docker buildx build --platform linux/amd64,linux/arm64 .       # both (amd64 builds under emulation on arm64)
#   docker build --target test -t trina-drive:test .               # + dev dependencies and the test suite
#
# Runtime: Debian 13 slim, Bun (the server runs its TypeScript sources: isolated workers start `bun
# src/worker/entry.ts` under bwrap, so there is no single compiled binary), bubblewrap (worker sandbox), ripgrep
# (pinned download, scripts/tools.json), pdftotext (Debian poppler-utils), tini (PID 1). Runs as uid 10001.
# Workers need the security settings in docker-compose.yml; without them the server starts but refuses shell commands
# and document extraction, and says why (docs/DOCKER.md, "Security settings").
#
# Base images are pinned by digest (multi-platform index). To update: docker buildx imagetools inspect <image:tag>.
ARG BUN_IMAGE=oven/bun:1.3.12-slim@sha256:d3c7094c144dd3975d183a4dbc4ec0a764223995bff73290d983edb47043a75f
ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

# ---- the Bun runtime for the target platform (only its binary is used)
FROM ${BUN_IMAGE} AS bun

# ---- build: the web app, production dependencies, pinned tools, manifest. Runs on the build machine's platform:
# its outputs (JavaScript, the target's ripgrep download) do not depend on where it runs.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.json ./
# lifecycle scripts never run (the optional native compressors of just-bash are not needed)
RUN bun install --frozen-lockfile --ignore-scripts
COPY web ./web
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
RUN bun run build:web
RUN mkdir /prod && cp package.json bun.lock /prod/ && cd /prod && bun install --frozen-lockfile --production --ignore-scripts && rm -rf node_modules/.bin
ARG TARGETARCH
RUN bun scripts/docker/tools.ts "linux-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo arm64)" /out
# /app as it ships, and SHA256SUMS of every file in it (scripts/build.ts writeChecksums, the release manifest format;
# check with: docker run --rm --entrypoint sh <image> -c 'cd /app && sha256sum -c --quiet SHA256SUMS')
RUN mkdir -p /app/web /app/docs \
 && cp -r src package.json bunfig.toml tsconfig.json /app/ \
 && cp -r web/dist /app/web/dist \
 && cp docs/DOCKER.md docs/BACKUP-FORMAT.md docs/worker.md /app/docs/ \
 && cp -r /prod/node_modules /app/node_modules \
 && bun -e "await (await import('/src/scripts/build.ts')).writeChecksums('/app')"

# ---- runtime
FROM ${DEBIAN_IMAGE} AS runtime
ARG VERSION=0.0.1
ARG REVISION=unknown
ARG CREATED=unknown
# Debian packages come from the base image's release with the security updates current at build time; the exact
# versions are listed in /usr/share/trina-drive/packages.txt and in the SBOM (docs/DOCKER.md, "Supply chain").
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap poppler-utils poppler-data tini tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && mkdir -p /usr/share/trina-drive \
 && dpkg-query -W -f '${Package} ${Version}\n' > /usr/share/trina-drive/packages.txt
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /out/tools/bin/rg /usr/local/bin/rg
COPY --from=build /out/tools/licenses /usr/share/trina-drive/licenses
COPY --from=build /out/tools.json /usr/share/trina-drive/tools.json
COPY --from=build /app /app
COPY --chmod=0755 docker/tdrive /usr/local/bin/tdrive
# the server's account; /data is its data directory (the installed layout, src/layout.ts), mounted as a volume
RUN groupadd --system --gid 10001 tdrive \
 && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin tdrive \
 && mkdir -p /data && chown 10001:10001 /data && chmod 0700 /data
ENV TDRIVE_HOME=/data \
    TDRIVE_LAYOUT=installed \
    TDRIVE_RG=/usr/local/bin/rg \
    TDRIVE_PDFTOTEXT=/usr/bin/pdftotext \
    TDRIVE_CONTAINER=docker \
    HOME=/tmp \
    LANG=C.UTF-8 \
    TZ=UTC \
    NO_COLOR=1 \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /app
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/usr/local/bin/bun", "-e", "fetch(process.env.TDRIVE_HEALTH_URL || 'http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tdrive"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8787"]
LABEL org.opencontainers.image.title="Trina Drive" \
      org.opencontainers.image.description="Self-hosted, permission-aware team file server for AI agents (MCP): agents see only what each person may see, never touch originals, every read is logged" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/potenlab/trina-drive" \
      org.opencontainers.image.url="https://drive.trina.app" \
      org.opencontainers.image.vendor="Trina Inc." \
      org.opencontainers.image.licenses="NOASSERTION" \
      org.opencontainers.image.base.name="docker.io/library/debian:trixie-slim"

# ---- test: the runtime image plus dev dependencies, the test suite and the tools some tests call (ps, shasum)
FROM runtime AS test
USER root
RUN apt-get update && apt-get install -y --no-install-recommends procps perl && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/node_modules /app/node_modules
COPY test /app/test
COPY tests /app/tests
COPY sim /app/sim
COPY scripts /app/scripts
COPY web /app/web
COPY --from=build /src/web/dist /app/web/dist
# the tests choose their own data directories and layouts
ENV TDRIVE_HOME= TDRIVE_LAYOUT=
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/bun", "test", "--timeout", "30000"]

# ---- the default target is the runtime image (the test stage above is built only with --target test)
FROM runtime AS release
