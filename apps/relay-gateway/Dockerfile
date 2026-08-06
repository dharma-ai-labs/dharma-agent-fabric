FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/relay-gateway ./apps/relay-gateway
RUN npm ci && npm run clean && npm run build

FROM node:22.22.0-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/relay-gateway/dist ./apps/relay-gateway/dist
USER node
CMD ["node", "apps/relay-gateway/dist/server.js"]
