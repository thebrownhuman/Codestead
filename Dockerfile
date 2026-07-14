# syntax=docker/dockerfile:1.7
# Architecture-specific digest for the reviewed linux/amd64 Intel NUC target.
ARG NODE_IMAGE=node:22.23.1-alpine3.23@sha256:4848379985144e72c7537574c1a894d4ec096704b21ce45e5eee386be9fab737

FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Build stages retain npm. Every shipped application stage starts here instead
# and contains only the Node runtime, not globally installed package managers.
FROM base AS final-base
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /opt/yarn-* \
    && rm -f \
      /sbin/apk \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
    && ! command -v apk \
    && ! command -v npm \
    && ! command -v npx \
    && ! command -v corepack \
    && ! command -v yarn \
    && ! command -v yarnpkg

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM base AS source
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

FROM source AS builder
ENV NODE_ENV=production
RUN mkdir -p public && npm run content:validate
RUN npm run build

# Kept separate from the application image so migration tooling is not shipped
# in the long-running web container.
FROM final-base AS tooling
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node drizzle ./drizzle
COPY --chmod=0555 infra/docker/entrypoint.sh /usr/local/bin/learncoding-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/learncoding-entrypoint"]
CMD ["node", "--input-type=module", "--eval", "import pg from 'pg'; import { drizzle } from 'drizzle-orm/node-postgres'; import { migrate } from 'drizzle-orm/node-postgres/migrator'; const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 }); try { await migrate(drizzle(pool), { migrationsFolder: '/app/drizzle' }); } finally { await pool.end(); }"]

FROM final-base AS worker
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node tsconfig.json ./tsconfig.json
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/process-outbox.ts ./scripts/process-outbox.ts
COPY --chown=node:node scripts/data-lifecycle.ts ./scripts/data-lifecycle.ts
COPY --chown=node:node scripts/process-rewards.ts ./scripts/process-rewards.ts
COPY --chmod=0555 infra/docker/entrypoint.sh /usr/local/bin/learncoding-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/learncoding-entrypoint"]
CMD ["node", "--import", "tsx", "/app/scripts/process-outbox.ts"]

FROM worker AS regrade-worker
COPY --chown=node:node scripts/process-assessment-regrades.ts ./scripts/process-assessment-regrades.ts
COPY --chown=node:node scripts/process-exam-finalizations.ts ./scripts/process-exam-finalizations.ts
COPY --chown=node:node scripts/process-practice-runner-recoveries.ts ./scripts/process-practice-runner-recoveries.ts
CMD ["node", "--import", "tsx", "/app/scripts/process-assessment-regrades.ts"]

FROM worker AS project-review-correction-worker
COPY --chown=node:node scripts/process-project-review-corrections.ts ./scripts/process-project-review-corrections.ts
CMD ["node", "--import", "tsx", "/app/scripts/process-project-review-corrections.ts"]

# Upload bytes remain on the trusted storage mount. This worker receives that
# mount read-only and streams objects to clamd over an internal Compose network.
FROM worker AS scanner-worker
COPY --chown=node:node scripts/scan-uploads.ts ./scripts/scan-uploads.ts
CMD ["node", "--import", "tsx", "/app/scripts/scan-uploads.ts"]

FROM final-base AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# Curriculum is read dynamically from process.cwd()/content.
COPY --from=builder --chown=node:node /app/content ./content
COPY --chmod=0555 infra/docker/entrypoint.sh /usr/local/bin/learncoding-entrypoint
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/learncoding-entrypoint"]
CMD ["node", "server.js"]
