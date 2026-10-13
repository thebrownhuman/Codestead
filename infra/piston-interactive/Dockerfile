# Derived offline from the immutable, locally built checksum-locked batch image.
ARG PISTON_BASE_IMAGE=codestead-piston@sha256:0000000000000000000000000000000000000000000000000000000000000000
FROM ${PISTON_BASE_IMAGE}
ARG PISTON_BASE_IMAGE
COPY --chmod=0444 Dockerfile .dockerignore patch.mjs connection.mjs base-image.json base-inputs.sha256 build-inputs.sha256 /interactive-build/
RUN cd /interactive-build && sha256sum -c build-inputs.sha256 \
    && cmp base-inputs.sha256 /usr/local/share/codestead-piston/build-inputs.sha256 \
    && node /interactive-build/patch.mjs /piston_api/src /piston/packages /interactive-build/connection.mjs \
    && test -x /usr/bin/stdbuf
COPY --chmod=0444 build-inputs.sha256 /usr/local/share/codestead-piston-interactive/build-inputs.sha256
LABEL org.opencontainers.image.title="Codestead interactive Piston" \
    io.codestead.piston-interactive.base-image="${PISTON_BASE_IMAGE}" \
    org.opencontainers.image.source="https://github.com/thebrownhuman/Codestead"
