# Build context: repo root (see infra/docker-compose.yml)
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway
RUN pnpm install --frozen-lockfile --filter @livecanvas/gateway...
RUN pnpm --filter @livecanvas/gateway build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PROMPTS_DIR=/app/prompts
COPY --from=build /repo/apps/gateway/dist ./dist
COPY prompts ./prompts
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
