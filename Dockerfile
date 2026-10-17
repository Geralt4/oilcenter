# Oil Center — production image.
#   docker build -t oilcenter .
#   docker run -p 3000:3000 --env-file .env.production -v oilcenter-data:/app/data oilcenter
# The /app/data volume holds the SQLite database, admin uploads and backups: it MUST be persistent.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 DATA_DIR=/app/data DATABASE_URL=file:/app/data/shop.db
COPY --from=build /app/package.json /app/package-lock.json /app/next.config.ts /app/drizzle.config.ts /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/catalog ./catalog
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
# Next writes optimized-image entries here at runtime. As root during the COPY, the directory would
# otherwise stay root-owned and every image request would log EACCES once the process drops to `node`.
RUN mkdir -p /app/.next/cache && chown -R node:node /app/.next/cache
# No VOLUME instruction on purpose: several hosts (e.g. Railway) reject it. Mount the platform's
# persistent volume at /app/data instead.
#
# The web process never runs as root: docker/entrypoint.sh starts as root only to give /app/data to
# the `node` user (host mounts can be root-owned), then re-execs everything — migrations, seeds, the
# Next.js server — as `node` through gosu. gosu (not su/sudo) keeps signal handling and no-new-privs
# behaviour intact, and it is the only extra package in the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh
EXPOSE 3000
# Migrations are idempotent; the seed only fills an EMPTY catalogue and never touches orders; data patches
# (scripts/patches.ts) run once per database. tsx (a dev dependency) stays in the image on purpose: the
# startup command runs the migration scripts through it.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sh", "-c", "npm run db:migrate && npm run db:seed && npm run db:patch && npm run start"]
