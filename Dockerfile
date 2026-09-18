# The hosted taskflow dashboard: server/ plus the report code it reuses from scripts/.
# Built from the repository root because server/ imports ../scripts/report/*.
# The plugin itself never needs this file; Claude Code ignores it.

FROM node:24-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/server/node_modules server/node_modules
COPY .claude-plugin/plugin.json .claude-plugin/plugin.json
COPY scripts/report scripts/report
COPY server server
USER node
# PORT is given by the host. main.mjs refuses to start on a public address without sign-in configured.
CMD ["node", "server/main.mjs"]
