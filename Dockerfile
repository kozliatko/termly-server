# Dependencies are installed in their own stage so the runtime image carries no
# npm cache and no build metadata.
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


FROM node:22-alpine AS runtime

ENV NODE_ENV=production

# The relay listens on the container's public interface; the proxy in front is
# what decides who may reach it.
ENV TERMLY_BIND=0.0.0.0
ENV TERMLY_LOCAL_PORT=3000

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js history.js ./

# The web client is served straight from disk; xterm is vendored into
# public/vendor, so no build step and no extra runtime dependency.
COPY public ./public

# The dashboard's event log lives here, on a volume the compose file mounts -
# owned by "node" up front, since it is created before that user can chown
# anything itself.
RUN mkdir -p /app/data && chown node:node /app/data

# node:alpine ships an unprivileged "node" user; a relay that spawns nothing
# has no reason to run as root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.TERMLY_LOCAL_PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
