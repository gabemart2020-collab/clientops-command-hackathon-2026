# Build from the repository root. This image is local proof scaffolding, not a deployment.
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@12.3.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/mcp/package.json ./services/mcp/package.json

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY services/mcp/tsconfig*.json ./services/mcp/
COPY services/mcp/src ./services/mcp/src
RUN pnpm --filter @clientops/mcp build

FROM base AS runtime
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/services/mcp/dist ./services/mcp/dist
ENV NODE_ENV=production
USER node
EXPOSE 3001
# Loopback remains the default. Container port publishing needs an explicit
# MCP_BIND_HOST=0.0.0.0 override and a loopback-only host port mapping.
CMD ["node", "services/mcp/dist/main.js"]
