# syntax=docker/dockerfile:1.7
# Trina Cloud control plane. One image, three uses:
#   serve        the control plane (AWS: on the control host, behind Caddy.control; no Docker access)
#   seal, seal-dir   a throwaway helper on the team hosts (backups, sealed SSM outputs): `docker run --rm … <image> seal-dir …`
#   --target dev the same plus the Docker CLI, for the local driver (cloud/dev/up.sh mounts the engine's socket)
#
#   docker build -t tdcloud-control:dev --target dev cloud/control
#   docker build -t tdcloud-control:<version> cloud/control
ARG BUN_IMAGE=oven/bun:1.3.12-slim@sha256:d3c7094c144dd3975d183a4dbc4ec0a764223995bff73290d983edb47043a75f
ARG DOCKER_CLI_IMAGE=docker:29.2.1-cli@sha256:cab69e2d0a1a2ea9a1ce1060252f439e83483ae41ec09317aecb33b08a0656a5

FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN groupadd --system --gid 10002 tdcloud \
 && useradd --system --uid 10002 --gid 10002 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin tdcloud \
 && mkdir -p /var/lib/tdcloud && chown 10002:10002 /var/lib/tdcloud && chmod 0700 /var/lib/tdcloud
ENV TDCLOUD_STATE_DIR=/var/lib/tdcloud \
    TDCLOUD_LISTEN_HOST=0.0.0.0 \
    NO_COLOR=1 \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
USER 10002:10002
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["bun", "/app/src/main.ts"]
CMD ["serve"]
LABEL org.opencontainers.image.title="Trina Cloud control plane" \
      org.opencontainers.image.source="https://github.com/potenlab/trina-drive" \
      org.opencontainers.image.licenses="Apache-2.0"

# Local development: the Docker CLI for the local driver. It talks to the engine through the mounted socket, which is
# root-equivalent on that engine: this target is for a developer's machine (or a single trusted box), never for the
# AWS control host, where the AWS driver uses SSM instead.
FROM runtime AS dev
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
USER 0:0

FROM runtime AS release
