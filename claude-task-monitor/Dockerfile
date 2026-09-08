# ── Stage 1: build ────────────────────────────────────────────────────────────
# Full install + Prisma generate + Next.js production build.
FROM node:22-alpine AS builder

WORKDIR /app

# Native addon deps: ssh2 requires python3/make/g++ to compile its native module.
RUN apk add --no-cache python3 make g++ libc6-compat

COPY package*.json ./
# ci = reproducible install matching package-lock.json exactly
RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

# Drop devDependencies (eslint, playwright, typescript, vitest, tailwind, ...)
# now that the build is done. tsx stays — it runs ws-server.ts at runtime.
RUN npm prune --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
# Alpine base (~170 MB) instead of the full Debian node:22 (~1 GB).
# Build tools (python3/make/g++) are not copied — they stay in the builder layer.
FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache libc6-compat

ENV NODE_ENV=production

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/app/generated ./app/generated
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/ws-server.ts ./ws-server.ts
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/instrumentation*.ts ./
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma.config.ts ./

# SSH key directory; actual key bind-mounted at runtime via docker-compose.yml.
RUN mkdir -p /app/.ssh && chmod 700 /app/.ssh

EXPOSE 3000
EXPOSE 3099

CMD ["sh", "-c", "npm start & npm run ws & wait"]
