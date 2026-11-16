# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
WORKDIR /app
COPY package*.json ./

# ── test: `docker build --target test .` fails the pipeline on type or test errors ──
FROM base AS test
RUN npm ci --ignore-scripts
COPY . .
RUN npm run typecheck && npm test

# ── runtime ──
FROM base AS prod
ENV NODE_ENV=production \
    DB_PATH=/data/service.sqlite \
    PORT=3000
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY scripts ./scripts

# SQLite lives on a mounted volume owned by the unprivileged node user (uid 1000).
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1

# Node 24 strips TypeScript types natively; there is no build step.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
