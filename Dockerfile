FROM node:24-alpine AS builder

ARG VITE_BRIDGE_HOST=
ARG VITE_BRIDGE_PORT=4281
ARG VITE_BRIDGE_ORIGIN=
ARG VITE_BRIDGE_WS_ORIGIN=
ARG VITE_DEFAULT_PROJECT_PATH=/workspace/company

ENV VITE_BRIDGE_HOST=${VITE_BRIDGE_HOST}
ENV VITE_BRIDGE_PORT=${VITE_BRIDGE_PORT}
ENV VITE_BRIDGE_ORIGIN=${VITE_BRIDGE_ORIGIN}
ENV VITE_BRIDGE_WS_ORIGIN=${VITE_BRIDGE_WS_ORIGIN}
ENV VITE_DEFAULT_PROJECT_PATH=${VITE_DEFAULT_PROJECT_PATH}

RUN apk add --no-cache \
  libc6-compat \
  make \
  g++ \
  python3

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:24-alpine AS runtime

ARG VITE_BRIDGE_HOST=
ARG VITE_BRIDGE_PORT=4281
ARG VITE_BRIDGE_ORIGIN=
ARG VITE_BRIDGE_WS_ORIGIN=
ARG VITE_DEFAULT_PROJECT_PATH=/workspace/company

ENV CCLIENT_BRIDGE_HOST=0.0.0.0
ENV CCLIENT_BRIDGE_PORT=4281
ENV UI_PORT=4273
ENV VITE_BRIDGE_HOST=${VITE_BRIDGE_HOST}
ENV VITE_BRIDGE_PORT=${VITE_BRIDGE_PORT}
ENV VITE_BRIDGE_ORIGIN=${VITE_BRIDGE_ORIGIN}
ENV VITE_BRIDGE_WS_ORIGIN=${VITE_BRIDGE_WS_ORIGIN}
ENV VITE_DEFAULT_PROJECT_PATH=${VITE_DEFAULT_PROJECT_PATH}

RUN apk add --no-cache \
  bash \
  ca-certificates \
  git \
  libc6-compat \
  openssh-client

WORKDIR /app

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bridge ./bridge
RUN npm install -g --no-fund --no-audit @openai/codex@latest && npm cache clean --force
RUN mkdir -p /workspace/company /workspace/settings

EXPOSE 4273 4281

CMD ["node", "./bridge/container-entry.mjs"]
