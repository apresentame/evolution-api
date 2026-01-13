FROM node:20-bookworm AS builder

ENV NODE_OPTIONS="--max-old-space-size=4096"

RUN apt-get update && \
    apt-get install -y \
    git ffmpeg wget curl bash openssl dos2unix \
    && rm -rf /var/lib/apt/lists/*

LABEL version="2.3.7" description="Api to control whatsapp features through http requests." 
LABEL maintainer="Davidson Gomes" git="https://github.com/DavidsonGomes"
LABEL contact="contato@evolution-api.com"

WORKDIR /evolution

COPY ./package*.json ./
COPY ./tsconfig.json ./
COPY ./tsup.config.ts ./

RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

COPY ./src ./src
COPY ./public ./public
COPY ./prisma ./prisma
COPY ./manager ./manager
COPY ./.env.example ./.env
COPY ./runWithProvider.js ./

COPY ./Docker ./Docker

RUN chmod +x ./Docker/scripts/* && dos2unix ./Docker/scripts/*

RUN ./Docker/scripts/generate_database.sh

RUN npm run build

FROM node:20-bookworm AS final

ENV NODE_OPTIONS="--max-old-space-size=4096"

RUN apt-get update && \
    apt-get install -y tzdata ffmpeg bash openssl \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=America/Sao_Paulo
ENV DOCKER_ENV=true

WORKDIR /evolution

COPY --from=builder /evolution/package.json ./package.json
COPY --from=builder /evolution/package-lock.json ./package-lock.json
COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/.env ./.env
COPY --from=builder /evolution/Docker ./Docker
COPY --from=builder /evolution/runWithProvider.js ./runWithProvider.js
COPY --from=builder /evolution/tsup.config.ts ./tsup.config.ts

EXPOSE 8080

CMD ["bash", "-c", ". ./Docker/scripts/deploy_database.sh && exec npm run start:prod"]
