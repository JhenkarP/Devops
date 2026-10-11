FROM node:22-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/server.js backend/database.js backend/api-contract.js backend/amr-scope.js backend/sequence-preflight.js backend/sequence-caller.js ./
COPY backend/migrations ./migrations
COPY scripts ./scripts
COPY shared ./shared
RUN apk add --no-cache docker-cli
ENV API_PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
