# syntax=docker/dockerfile:1.7
# Caddy for Trina Cloud: the official build plus two modules —
#   github.com/mholt/caddy-ratelimit   per-client-address rate limits in front of every team (sign-in, OAuth, MCP)
#   github.com/caddy-dns/route53       only for the wildcard-certificate option (DNS-01 on Route 53; README "TLS")
# Base images pinned by digest (multi-platform index); modules by tag.
ARG CADDY_BUILDER=caddy:2.10.2-builder@sha256:01668408cc26e2e00c9d067c30cb43b2ba14ad1f2808beda55503cb2a31f59dc
ARG CADDY_RUNTIME=caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

FROM ${CADDY_BUILDER} AS build
RUN xcaddy build \
      --with github.com/mholt/caddy-ratelimit@v0.1.0 \
      --with github.com/caddy-dns/route53@v1.6.2

FROM ${CADDY_RUNTIME}
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile Caddyfile.control Caddyfile.dev team_routes.caddy /etc/caddy/
COPY paused.html /srv/paused.html
RUN caddy list-modules | grep -E '^(http.handlers.rate_limit|dns.providers.route53)$'
