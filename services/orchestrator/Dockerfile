# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev
RUN rm -rf scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
