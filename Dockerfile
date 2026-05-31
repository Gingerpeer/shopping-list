# syntax=docker/dockerfile:1

# ---- Base image -------------------------------------------------------------
# A small, current LTS Node image. Alpine keeps the final image lean; the app
# has no native build dependencies now that it talks to PostgreSQL over the wire.
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- Dependencies -----------------------------------------------------------
# Install production dependencies in a dedicated layer so they are cached unless
# package manifests change.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime ---------------------------------------------------------------
FROM base AS runtime

# Run as the unprivileged user that ships with the Node image.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

# Railway provides PORT at runtime; default to 3000 for local runs.
ENV PORT=3000
EXPOSE 3000

# Lightweight container healthcheck hitting the app's health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
