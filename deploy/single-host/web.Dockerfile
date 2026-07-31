# syntax=docker/dockerfile:1
#
# Builds both SPAs and bakes them into a Caddy image.
#
# Building inside a container keeps Node off the host, and keeps the two builds
# reproducible regardless of what the instance happens to have installed. The
# runtime image carries only static files and Caddy — the toolchain is discarded.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Manifests first, so the dependency layer survives source-only changes.
# apps/child-app and services/api are not npm workspaces and are not needed here.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/family-app/package.json apps/family-app/
COPY apps/admin-dashboard/package.json apps/admin-dashboard/
RUN npm ci

COPY packages/ packages/
COPY apps/family-app/ apps/family-app/
COPY apps/admin-dashboard/ apps/admin-dashboard/

# Vite inlines these at build time. They are public values that ship to every
# browser — do not pass anything secret here.
#
# VITE_API_URL is deliberately left empty: Caddy serves /api and /socket.io on
# the same origin as each SPA, which is what the apps default to.
ARG VITE_GOOGLE_MAPS_KEY=""
ARG VITE_ADMIN_URL=""
ENV VITE_GOOGLE_MAPS_KEY=$VITE_GOOGLE_MAPS_KEY \
    VITE_ADMIN_URL=$VITE_ADMIN_URL \
    VITE_API_URL=""

RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM caddy:2-alpine

COPY --from=build /app/apps/family-app/dist  /srv/family
COPY --from=build /app/apps/admin-dashboard/dist /srv/admin
COPY deploy/single-host/Caddyfile /etc/caddy/Caddyfile
