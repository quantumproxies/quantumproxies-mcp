# QuantumProxies MCP server — stdio transport.
#
# The server starts even without QUANTUMPROXIES_API_KEY so that introspection
# (initialize + tools/list) works for registries and inspectors; tool calls
# then fail with a clear message. Pass the key to make real API calls:
#
#   docker build -t quantumproxies-mcp .
#   docker run -i --rm -e QUANTUMPROXIES_API_KEY=qp_live_... quantumproxies-mcp
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
