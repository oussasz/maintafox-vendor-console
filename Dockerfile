# syntax=docker/dockerfile:1
# Production image: build SPA with Vite, serve with nginx.

FROM node:20-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Inlined at build time (Vite). Point to your real admin API on the VPS or CDN.
ARG VITE_ADMIN_API_BASE_URL=https://api.maintafox.systems
ARG VITE_DEV_MOCK_AUTH=false
ARG VITE_BASE_PATH=/

ENV VITE_ADMIN_API_BASE_URL=$VITE_ADMIN_API_BASE_URL
ENV VITE_DEV_MOCK_AUTH=$VITE_DEV_MOCK_AUTH
ENV VITE_BASE_PATH=$VITE_BASE_PATH

RUN pnpm exec tsc --noEmit && pnpm exec vite build

FROM nginx:1.27-alpine
COPY deploy/nginx-docker.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
