# Gals Panic — Colyseus 게임 서버 (클라이언트·이미지까지 한 서버가 서빙).
# 빌드 단계에서 클라이언트 sim 번들 + 서버 dist 를 만들고, 운영 의존성만 남겨 실행 단계로 복사한다.
# Koyeb/Fly 등 어디서든 이 Dockerfile 하나로 빌드·배포된다.

# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app
# 의존성 먼저 (레이어 캐시)
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci
# 소스 복사 후 빌드 (client/sim.bundle.js + server/dist 생성)
COPY . .
RUN cd server && npm run build
# 실행에 필요한 운영 의존성만 남긴다
RUN cd server && npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-slim
WORKDIR /app
COPY --from=build /app/server ./server
COPY --from=build /app/client ./client
ENV NODE_ENV=production
# Koyeb/Fly 가 PORT 를 주입한다. 미설정 시 8000 사용.
ENV PORT=8000
EXPOSE 8000
WORKDIR /app/server
CMD ["node", "dist/index.js"]
