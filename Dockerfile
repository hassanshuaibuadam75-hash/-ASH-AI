# #ash Mesh — production image.
# Multi-stage: the client is built inside the image (client/dist is not committed) and dev
# dependencies are pruned before the runtime layer. Only the paths the server actually needs are
# copied, so a host node_modules directory can never leak into the build.
#
# Base is Node 24 LTS on Alpine (musl). Debian bases were rejected by the image security gate:
# Debian 12 and 13 both ship glibc carrying DEBIAN-CVE-2019-1010022 (a disputed advisory Debian
# does not fix) plus acl/attr/gcc advisories with no fixed version, so no Debian release can pass.
# Alpine has no glibc, acl, attr or gcc packages in the runtime layer.
FROM node:24-alpine AS build

# Toolchain for the one native module (better-sqlite3 has no musl prebuild, so node-gyp compiles it).
RUN apk upgrade --no-cache \
 && apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
# scripts/ must exist before npm ci: the postinstall hook runs scripts/check-native.js.
COPY scripts ./scripts
RUN npm ci

COPY server ./server
COPY client ./client

# Build the React client, then drop dev dependencies (vite, three tooling) from node_modules.
RUN npm run build \
 && npm prune --omit=dev

FROM node:24-alpine AS runtime

# libstdc++ is required by the compiled better-sqlite3 addon; ca-certificates for outbound TLS.
RUN apk upgrade --no-cache \
 && apk add --no-cache libstdc++ ca-certificates

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist

# SQLite database and uploaded media live here. On a plan without a persistent disk this is
# ephemeral; see docs/DEPLOYMENT.md before advertising durable storage.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "server/index.js"]
