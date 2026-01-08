FROM node:20-bullseye AS builder

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"

LABEL version="2.3.1" description="Api to control whatsapp features through http requests."
LABEL maintainer="Davidson Gomes" git="https://github.com/DavidsonGomes"
LABEL contact="contato@evolution-api.com"

WORKDIR /evolution

RUN apt-get update && apt-get install -y \
  git \
  ffmpeg \
  wget \
  curl \
  bash \
  openssl \
  python3 \
  make \
  g++ \
  dos2unix \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY tsconfig.json ./
COPY tsup.config.ts ./

RUN npm ci

COPY src ./src
COPY public ./public
COPY prisma ./prisma
COPY manager ./manager
COPY .env.example ./.env
COPY runWithProvider.js ./
COPY Docker ./Docker

RUN chmod +x ./Docker/scripts/* && dos2unix ./Docker/scripts/*

RUN ./Docker/scripts/generate_database.sh

RUN npm run build

# ---------- FINAL ----------
FROM node:20-bullseye AS final

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
ENV TZ=America/Sao_Paulo
ENV DOCKER_ENV=true

RUN apt-get update && apt-get install -y \
  tzdata \
  ffmpeg \
  bash \
  openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /evolution

COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/.env ./.env
COPY --from=builder /evolution/Docker ./Docker
COPY --from=builder /evolution/runWithProvider.js ./runWithProvider.js
COPY --from=builder /evolution/package.json ./package.json

EXPOSE 8080

ENTRYPOINT ["/bin/bash", "-c", ". ./Docker/scripts/deploy_database.sh && npm run start:prod"]
