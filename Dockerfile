FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
ARG DATABASE_URL=postgresql://vwray:build-only@localhost:5432/vwray?schema=public
ENV DATABASE_URL=$DATABASE_URL
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /app
ARG DATABASE_URL=postgresql://vwray:build-only@localhost:5432/vwray?schema=public
ENV DATABASE_URL=$DATABASE_URL
ENV NODE_OPTIONS=--max-old-space-size=1536
ENV AUTH_SECRET=build-only-auth-secret-not-used-at-runtime
ENV ENCRYPTION_KEY=build-only-encryption-key-not-used-at-runtime
COPY . .
RUN npx prisma generate
RUN npm run build -- --webpack

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["node", "server.js"]
