# syntax=docker/dockerfile:1.6

ARG NPM_VERSION=11.6.2

FROM node:20-alpine AS deps
ARG NPM_VERSION
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN npm install -g "npm@${NPM_VERSION}"
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci

FROM node:20-alpine AS build
ARG NPM_VERSION
WORKDIR /app
RUN npm install -g "npm@${NPM_VERSION}"
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
ARG NPM_VERSION
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g "npm@${NPM_VERSION}"
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev
RUN rm -rf scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
