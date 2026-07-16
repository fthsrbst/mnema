# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS server-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS web-build
WORKDIR /app
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_PADDLE_CLIENT_TOKEN
ARG VITE_PADDLE_ENVIRONMENT=sandbox
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_PADDLE_CLIENT_TOKEN=$VITE_PADDLE_CLIENT_TOKEN \
    VITE_PADDLE_ENVIRONMENT=$VITE_PADDLE_ENVIRONMENT
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY web ./web
RUN npm --prefix web run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HUB_HOST=0.0.0.0 \
    HUB_PORT=8033
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=server-build --chown=node:node /app/dist ./dist
COPY --from=web-build --chown=node:node /app/web/dist ./web/dist
USER node
EXPOSE 8033
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8033/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/index.js"]
