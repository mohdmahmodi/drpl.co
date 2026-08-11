# syntax=docker/dockerfile:1
#
# drpl.co signaling server.
#
# No build step. Two stages only to keep npm's cache and lockfile machinery out
# of the shipped layer. Files are copied by name rather than with `COPY . .`, so
# a .env can never end up baked into an image.

# --- dependencies ----------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- runtime ---------------------------------------------------------------
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public

# Unprivileged user shipped by the official image. Nothing here writes to disk.
USER node

# Metadata only. Dokploy reads this to work out where to send traffic; the app
# reads PORT and falls back to 3003.
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const p=process.env.PORT||3003;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]