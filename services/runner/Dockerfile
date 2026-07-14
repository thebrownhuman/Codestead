# Keep this linux/amd64 digest explicit; update only after rebuilding and testing the runner.
FROM node:22-bookworm-slim@sha256:a149cd71dccd68704a07d4e4ca3e610c27301852b0f556865cfdb6e2856f8bed AS build
WORKDIR /srv/runner
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim@sha256:a149cd71dccd68704a07d4e4ca3e610c27301852b0f556865cfdb6e2856f8bed AS verification-artifact
LABEL io.learncoding.runner.image-role="verification-only"
ENV NODE_ENV=production
WORKDIR /srv/runner
COPY --from=build --chown=node:node /srv/runner/dist ./dist
USER node
# This stage exists only to inspect, generate an SBOM for, and vulnerability-scan
# the compiled artifact. Production runs the host artifact through the systemd
# unit and infra/runner/run-runner.sh. Fail closed if this image is launched.
CMD ["node", "-e", "console.error('verification-only image: use the systemd runner deployment'); process.exit(64)"]
