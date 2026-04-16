# Stage 1: Build Svelte frontend
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Server runtime
FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache wget

COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist

RUN mkdir -p /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/api/folders || exit 1

CMD ["node", "server/index.js"]
