FROM node:24-alpine

ENV CCLIENT_BRIDGE_HOST=0.0.0.0
ENV CCLIENT_BRIDGE_PORT=4281
ENV UI_PORT=4273

RUN apk add --no-cache \
  bash \
  ca-certificates \
  git \
  openssh-client \
  python3 \
  make \
  g++ \
  libc6-compat

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build
RUN npm install -g @openai/codex@latest

EXPOSE 4273 4281

CMD ["npx", "concurrently", "-k", "-n", "ui,bridge", "npm run preview -- --host 0.0.0.0 --port 4273", "npm run bridge"]
