# One image for every role: setup (migrations and seed), api, worker and web.
# Build arg NPM_REGISTRY switches the npm registry (e.g. http://registry.npmmirror.com in mainland
# China). Build arg APT_MIRROR switches the Debian mirror (e.g. http://mirrors.cloud.tencent.com):
# deb.debian.org is unreachable from the Shanghai box (ym767) and its proxy/resolver MITMs TLS
# (https mirrors fail cert verification inside containers), so the mirror is meant to be http://.
# Note: the rewrite lands in the base stage, so the runtime image also carries the rewritten
# sources file; harmless because the runtime never runs apt (USER node).
FROM node:24-trixie-slim AS base
ARG APT_MIRROR=
WORKDIR /app
# pg_dump for the optional database backups (Debian's client matches the PostgreSQL 17 server in compose).
RUN if [ -n "$APT_MIRROR" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        [ -f "$f" ] && sed -i \
          -e "s#https\?://deb.debian.org#${APT_MIRROR}#g" \
          -e "s#https\?://security.debian.org#${APT_MIRROR}#g" "$f" || true; \
      done; \
    fi; \
    apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
ARG NPM_REGISTRY=
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/backend/package.json packages/backend/
COPY packages/contracts/package.json packages/contracts/
COPY industry/package.json industry/
RUN npm ci --no-audit --no-fund ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}
COPY . .
RUN npm run build -w @aihot/web && npm prune --omit=dev --no-audit --no-fund

FROM base
# Release provenance (K2): the commit is baked in at build time and never hand-copied into .env.
# /api/health echoes this value, so it can no longer claim a different release than the image.
ARG AIHOT_RELEASE=dev
ENV NODE_ENV=production \
    AIHOT_RELEASE=${AIHOT_RELEASE}
LABEL org.opencontainers.image.revision=${AIHOT_RELEASE}
# Build guard (K2 audit P2-2 / ym956): a forgotten --build-arg used to silently bake the default
# "dev" in as the /api/health release anchor. Refuse the literal default and fail the build;
# local dev builds pass "dev-local" via compose build.args, cloud releases override with
# --build-arg AIHOT_RELEASE=$SHA8 per deploy/README-deploy.md step 4.
RUN test "$AIHOT_RELEASE" != "dev" || \
  { echo "ERROR: AIHOT_RELEASE build-arg missing (still default 'dev'); see deploy/README-deploy.md step 4 (--build-arg AIHOT_RELEASE=<short-sha>)" >&2; exit 1; }
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.ts"]
