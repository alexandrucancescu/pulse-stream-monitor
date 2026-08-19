# Node 24 for a stable built-in node:sqlite (no native module to compile).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build          # → dist/ui
RUN npm prune --omit=dev    # drop vite/solid/typescript, keep runtime deps + tsx

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./tsconfig.json ./tsconfig.server.json ./

# Mount a volume here so the SQLite history survives redeploys.
RUN mkdir -p /app/data
ENV MONITOR_DB=/app/data/monitor.db

EXPOSE 4000
CMD ["npm", "run", "start"]
