# syntax=docker/dockerfile:1
#
# Agents service image (Node 24 + tsx), also serving the built viewer at /.
# Build context MUST be the repo root:
#   docker build -f agents/Dockerfile .
#
# The app reads ../data/game-data.json.gz relative to the agents dir
# (/app/data/game-data.json.gz here), serves HTTP on $PORT (default 8787)
# and writes logs to $LOG_DIR (default ./logs).

# ---------- viewer build ----------
FROM node:24-slim AS viewer
WORKDIR /app/viewer
COPY viewer/package.json viewer/package-lock.json ./
RUN npm ci
COPY viewer/ ./
# same-origin: the viewer talks to the API on whatever host serves it
RUN VITE_API_URL=same-origin npm run build

# ---------- agents runtime ----------
FROM node:24-slim

WORKDIR /app/agents

# tsx + typescript are runtime deps (npm start -> tsx src/main.ts)
COPY agents/package.json agents/package-lock.json ./
RUN npm ci

COPY agents/ ./
COPY data/ /app/data/
COPY --from=viewer /app/viewer/dist /app/viewer/dist

RUN mkdir -p /app/agents/logs

EXPOSE 8787

CMD ["npm", "start"]
