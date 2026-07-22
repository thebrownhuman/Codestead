# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# Architecture-specific digest for the reviewed linux/amd64 Intel NUC target.
ARG NODE_IMAGE=node:22.23.1-alpine3.23@sha256:4848379985144e72c7537574c1a894d4ec096704b21ce45e5eee386be9fab737
ARG SOURCE_REPOSITORY
ARG SOURCE_REVISION
ARG SOURCE_DATE_EPOCH
ARG SOURCE_TREE
ARG SOURCE_CONTEXT_SHA256

FROM ${NODE_IMAGE} AS base
ARG SOURCE_REPOSITORY
ARG SOURCE_REVISION
ARG SOURCE_DATE_EPOCH
ARG SOURCE_TREE
ARG SOURCE_CONTEXT_SHA256
LABEL org.opencontainers.image.source=${SOURCE_REPOSITORY} \
      org.opencontainers.image.revision=${SOURCE_REVISION} \
      io.codestead.application.source-tree=${SOURCE_TREE} \
      io.codestead.application.build-context-sha256=${SOURCE_CONTEXT_SHA256} \
      io.codestead.application.platform=linux/amd64
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
COPY --chown=node:node scripts/migrate-production.mjs ./scripts/migrate-production.mjs
COPY --chmod=0555 infra/docker/entrypoint.sh /usr/local/bin/learncoding-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/learncoding-entrypoint"]
CMD ["node", "/app/scripts/migrate-production.mjs"]

FROM final-base AS worker
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node tsconfig.json ./tsconfig.json
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/lib/worker-health.ts ./scripts/lib/worker-health.ts
COPY --chown=node:node scripts/check-worker-health.ts ./scripts/check-worker-health.ts
COPY --chown=node:node scripts/process-outbox.ts ./scripts/process-outbox.ts
COPY --chown=node:node scripts/data-lifecycle.ts ./scripts/data-lifecycle.ts
COPY --chown=node:node scripts/process-rewards.ts ./scripts/process-rewards.ts
COPY --chown=node:node scripts/process-file-erasures.ts ./scripts/process-file-erasures.ts
COPY --chmod=0555 infra/docker/entrypoint.sh /usr/local/bin/learncoding-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/learncoding-entrypoint"]
CMD ["node", "--import", "tsx", "/app/scripts/process-outbox.ts"]

FROM worker AS operations
COPY --chown=node:node content ./content
COPY --chown=node:node scripts/bootstrap-admin.ts ./scripts/bootstrap-admin.ts
COPY --chown=node:node scripts/bootstrap-database-roles.mjs ./scripts/bootstrap-database-roles.mjs
COPY --chown=node:node scripts/verify-database-role-boundaries.mjs ./scripts/verify-database-role-boundaries.mjs
COPY --chown=node:node scripts/backup/create-credential-probe.ts ./scripts/backup/create-credential-probe.ts
COPY --chown=node:node scripts/lib/runner-power-rehearsal-cli.ts ./scripts/lib/runner-power-rehearsal-cli.ts
COPY --chown=node:node scripts/runner-power-rehearsal.ts ./scripts/runner-power-rehearsal.ts
COPY --chown=node:node scripts/verify-restored-backup.ts ./scripts/verify-restored-backup.ts
COPY --chown=node:node scripts/seed-platform.ts ./scripts/seed-platform.ts
CMD ["node", "--import", "tsx", "/app/scripts/seed-platform.ts"]

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
COPY --chown=node:node infra/runner-gateway/server.mjs ./runner-gateway/server.mjs
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# Curriculum is read dynamically from process.cwd()/content.
COPY --from=builder --chown=node:node /app/content ./content
COPY --chmod=0555 infra/docker/entrypoint.sh /usr/local/bin/learncoding-entrypoint
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/learncoding-entrypoint"]
CMD ["node", "server.js"]
