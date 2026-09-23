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
# No VOLUME instruction on purpose: several hosts (e.g. Railway) reject it. Mount the platform's
# persistent volume at /app/data instead.
#
# The container runs as root. Dropping to an unprivileged USER is desirable, but two things must be handled
# first, or the app breaks on start: (1) the startup command below runs the migrate/seed/patch scripts through
# tsx (a dev dependency kept in the image on purpose), and (2) the mounted /app/data volume must be writable by
# that user — on some hosts the mount is root-owned, so this needs a chown/init step for the specific platform.
EXPOSE 3000
# Migrations are idempotent; the seed only fills an EMPTY catalogue and never touches orders; data patches
# (scripts/patches.ts) run once per database.
CMD ["sh", "-c", "npm run db:migrate && npm run db:seed && npm run db:patch && npm run start"]
