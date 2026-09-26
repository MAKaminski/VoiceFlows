# Build context: repo root (see infra/docker-compose.yml)
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @livecanvas/web...
ARG NEXT_PUBLIC_GATEWAY_WS=ws://localhost:8787/ws
ENV NEXT_PUBLIC_GATEWAY_WS=$NEXT_PUBLIC_GATEWAY_WS
RUN pnpm --filter @livecanvas/web build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
