# #ash Mesh — production image.
# Multi-stage: the client is built inside the image (client/dist is not committed) and dev
# dependencies are pruned before the runtime layer. Only the paths the server actually needs are
# copied, so a host node_modules directory can never leak into the build.
FROM node:24-slim AS build

RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY server ./server
COPY client ./client

# Build the React client, then drop dev dependencies (vite, three tooling) from node_modules.
RUN npm run build \
 && npm prune --omit=dev

FROM node:24-slim AS runtime

# Distributor security fixes for the runtime OS packages, then keep the image lean.
RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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
