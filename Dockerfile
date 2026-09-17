# ---- Stage 1: Builder ----
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Stage 2: Production ----
FROM node:22-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -f package*.json

COPY --chown=node:node --from=builder /app/dist ./dist

COPY --chown=node:node --from=builder /app/node_modules ./node_modules

USER node

EXPOSE 3003

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]