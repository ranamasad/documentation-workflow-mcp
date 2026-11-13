# Documentation Workflow MCP, self-hosted.
#   docker build -t documentation-mcp .
#   docker run -p 4318:4318 --env-file .env -v "$PWD/projects.json:/app/projects.json:ro" \
#     -v "$PWD/secrets:/app/secrets:ro" -v "$PWD/.mcp-data:/app/.mcp-data" documentation-mcp
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY api ./api
COPY tests ./tests
COPY scripts ./scripts
COPY contract ./contract
COPY contract-v3 ./contract-v3
COPY vendor ./vendor
COPY public ./public
COPY examples ./examples
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 4318
CMD ["node", "dist/src/local.js"]
