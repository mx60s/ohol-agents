# syntax=docker/dockerfile:1
#
# Artificial Selection, all-in-one image (Fly): OHOL game server + agents
# service + built viewer, supervised by deploy/start.sh.
# Build context MUST be the repo root:
#   docker build -f deploy/Dockerfile .        (fly deploy does this via fly.toml)
#
# Stages:
#   ohol    compile OneLifeServer at the pinned tags with server/patches (server/build.sh)
#   viewer  npm run assets (real OHOL art) + vite build with VITE_API_URL=same-origin
#   agents  npm ci for the agents service
#   final   node:24 bookworm-slim + the server binary/data + agents + viewer dist
#
# Runtime layout:
#   /opt/ohol/OneLife/server   OneLifeServer + stock settings + relative data symlinks
#   /opt/ohol/OneLifeData7     objects, transitions, categories, ... (sparse)
#   /app/server                run.sh + settings/*.ini overrides
#   /app/agents, /app/data, /app/viewer/dist
#   /data                      Fly volume: /data/world (game DBs), /data/logs (LOG_DIR)

# Same Debian release in every stage so the C++ binary's glibc/libstdc++ match.
ARG NODE_IMAGE=node:24-bookworm-slim

# ---------- ohol: game server ----------
FROM debian:bookworm-slim AS ohol
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash build-essential ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY server/ server/
# Pinned upstream refs (build.sh reads them from the environment; keep in
# sync with build.sh / server/Dockerfile defaults).
ARG ONELIFE_REF=OneLife_liveServer
ARG MINORGEMS_REF=OneLife_v438
ARG DATA_REF=OneLife_v437
ARG SERVER_CODE_VERSION=438
# build.sh also runs the fresh binary once to dump game-data.json (unused here:
# the agents read the committed data/game-data.json.gz). Afterwards keep only
# what the server needs at runtime: OneLife/server without sources/objects and
# the sparse OneLifeData7 checkout without .git. minorGems is build-only.
RUN chmod +x server/build.sh \
 && server/build.sh /opt/ohol \
 && cd /opt/ohol \
 && rm -rf dump-scratch game-data.json minorGems OneLifeData7/.git \
 && find OneLife/server -maxdepth 1 -type f \
      \( -name '*.o' -o -name '*.cpp' -o -name '*.h' -o -name '*.dep' -o -name '*.dep2' \) -delete \
 && mv OneLife/server /tmp/server && rm -rf OneLife && mkdir OneLife && mv /tmp/server OneLife/server \
 && test -x OneLife/server/OneLifeServer && test -d OneLife/server/objects/

# ---------- viewer: static site served at / ----------
FROM ${NODE_IMAGE} AS viewer
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/viewer
COPY viewer/package.json viewer/package-lock.json ./
RUN npm ci
COPY data/ /app/data/
COPY viewer/ ./
# real OHOL art: sparse-clones OneLifeData7 at the pinned tag, converts sprites to PNG
RUN npm run assets
# same-origin: the pages call the API on whatever host serves them
RUN VITE_API_URL=same-origin npm run build

# ---------- agents: dependencies ----------
FROM ${NODE_IMAGE} AS agents
WORKDIR /app/agents
COPY agents/package.json agents/package-lock.json ./
# tsx runs the TypeScript directly; all deps are runtime deps
RUN npm ci --omit=dev && npm cache clean --force

# ---------- final ----------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
# bash runs start.sh/run.sh; libstdc++6 for OneLifeServer (normally already in the node image)
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

# keep OneLife/ and OneLifeData7/ siblings: OneLife/server/objects -> ../../OneLifeData7/objects
COPY --from=ohol /opt/ohol /opt/ohol
COPY server/run.sh   /app/server/run.sh
COPY server/settings /app/server/settings

COPY --from=agents /app/agents/node_modules /app/agents/node_modules
COPY agents/package.json agents/tsconfig.json /app/agents/
COPY agents/src /app/agents/src
COPY data/ /app/data/
COPY --from=viewer /app/viewer/dist /app/viewer/dist

COPY deploy/start.sh /app/deploy/start.sh
RUN chmod +x /app/server/run.sh /app/deploy/start.sh && mkdir -p /data

# 8787: HTTP (viewer + /api). The game port 8005 stays internal (127.0.0.1 only).
EXPOSE 8787
ENTRYPOINT ["/app/deploy/start.sh"]
