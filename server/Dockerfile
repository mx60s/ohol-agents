# syntax=docker/dockerfile:1
#
# OHOL game server image.
# Build context MUST be the repo root:
#   docker build -f server/Dockerfile .
#
# Builder stage: clone pinned upstream sources, apply server/patches/*,
# compile OneLifeServer and run the game-data dump (server/build.sh).
# Runtime stage: slim debian + libstdc++; server/run.sh links the build
# into the run dir and execs OneLifeServer with cwd=/data (persistent
# volume — world .db files and logs are written there).

# ---------- builder ----------
FROM debian:bookworm-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY server/ server/

# Pinned upstream refs (must match build.sh defaults). Override at build
# time with e.g. --build-arg DATA_REF=OneLife_v438
ARG ONELIFE_REF=OneLife_liveServer
ARG MINORGEMS_REF=OneLife_v438
ARG DATA_REF=OneLife_v437
ARG SERVER_CODE_VERSION=438

# build.sh resolves HERE from its own path, so it finds patches/ and
# tools/ under /repo/server. It also runs the freshly built server once
# (cwd = /opt/ohol/dump-scratch) to dump game-data.json.
RUN chmod +x server/build.sh \
 && server/build.sh /opt/ohol \
 && rm -rf /opt/ohol/dump-scratch \
              /opt/ohol/OneLife/.git \
              /opt/ohol/minorGems/.git \
              /opt/ohol/OneLifeData7/.git

# ---------- runtime ----------
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

# Keep the exact /opt/ohol layout from the builder: OneLife/server holds
# relative symlinks (objects -> ../../OneLifeData7/objects, ...) that only
# resolve while OneLife/ and OneLifeData7/ stay siblings under /opt/ohol.
COPY --from=builder /opt/ohol /opt/ohol

# run.sh reads $HERE/settings/*.ini (our overrides) and applies
# OHOL_SETTING_<name>=<value> env vars on top.
COPY server/run.sh   /app/server/run.sh
COPY server/settings /app/server/settings
COPY server/patches  /app/server/patches
RUN chmod +x /app/server/run.sh \
 && mkdir -p /data

# World DBs + logs live here. Mount a persistent volume at /data
# (Railway: service -> Volumes -> mount path /data).
# (no VOLUME instruction: Railway rejects it; attach a Railway Volume at /data)

# settings/port.ini -> 8005. SocketServerLinux.cpp binds INADDR_ANY.
EXPOSE 8005

ENTRYPOINT ["/app/server/run.sh", "/opt/ohol", "/data"]
