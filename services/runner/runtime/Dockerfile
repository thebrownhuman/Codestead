# syntax=docker/dockerfile:1.7
ARG HARNESS_BUILD_IMAGE
ARG HARNESS_BUILD_PACKAGES
ARG RUNTIME_IMAGE

FROM ${HARNESS_BUILD_IMAGE} AS harness-build
ARG EXPECTED_LANGUAGE
ARG HARNESS_BUILD_PACKAGES
RUN apk add --no-cache ${HARNESS_BUILD_PACKAGES}
WORKDIR /build
COPY harness.c ./harness.c
RUN mkdir -p /out && cc -std=c17 -O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
    -Wall -Wextra -Werror -Wpedantic \
    -static \
    -DEXPECTED_LANGUAGE=\"${EXPECTED_LANGUAGE}\" \
    -o /out/execute ./harness.c && chmod 0555 /out/execute

FROM ${RUNTIME_IMAGE}
ARG EXPECTED_LANGUAGE
ARG EXPECTED_TOOL_VERSION
ARG BASE_IMAGE_REFERENCE
ARG RUNTIME_PACKAGES
RUN set -eu; \
    if [ -n "${RUNTIME_PACKAGES}" ]; then apk add --no-cache ${RUNTIME_PACKAGES}; fi; \
    mkdir -p /usr/local/bin; \
    case "${EXPECTED_LANGUAGE}" in \
      c) \
        ln -s /usr/bin/gcc /usr/local/bin/gcc; \
        test "$(/usr/local/bin/gcc -dumpfullversion)" = "${EXPECTED_TOOL_VERSION}" \
        ;; \
      cpp) \
        ln -s /usr/bin/g++ /usr/local/bin/g++; \
        test "$(/usr/local/bin/g++ -dumpfullversion)" = "${EXPECTED_TOOL_VERSION}" \
        ;; \
      java) \
        mkdir -p /opt/java; \
        ln -s /usr/lib/jvm/java-21-openjdk /opt/java/openjdk; \
        /opt/java/openjdk/bin/java -XshowSettings:properties -version 2>&1 \
          | grep -F "java.version = ${EXPECTED_TOOL_VERSION}" >/dev/null \
        ;; \
      python) \
        rm -rf /usr/local/lib/python3.14/ensurepip \
          /usr/local/lib/python3.14/site-packages/pip \
          /usr/local/lib/python3.14/site-packages/pip-*.dist-info; \
        rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.14; \
        ! command -v pip >/dev/null 2>&1; \
        ! /usr/local/bin/python3 -m ensurepip --version >/dev/null 2>&1; \
        test "$(/usr/local/bin/python3 -c 'import platform; print(platform.python_version())')" = "${EXPECTED_TOOL_VERSION}" \
        ;; \
      javascript) \
        rm -rf /usr/local/lib/node_modules /opt/yarn-v*; \
        rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/yarn /usr/local/bin/yarnpkg; \
        test "$(/usr/local/bin/node --version)" = "v${EXPECTED_TOOL_VERSION}" \
        ;; \
      *) exit 64 ;; \
    esac; \
    rm -f /sbin/apk
LABEL org.opencontainers.image.title="Codestead ${EXPECTED_LANGUAGE} runtime" \
      org.opencontainers.image.description="Networkless, non-root learner-code runtime with fixed native harness" \
      org.opencontainers.image.vendor="Codestead" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      io.learncoding.runner.protocol="1" \
      io.learncoding.runner.language="${EXPECTED_LANGUAGE}" \
      io.learncoding.runner.base="${BASE_IMAGE_REFERENCE}" \
      io.learncoding.runner.packages="${RUNTIME_PACKAGES}"
COPY --from=harness-build --chown=65532:65532 --chmod=0555 /out/execute /opt/runner/execute
USER 65532:65532
WORKDIR /work
ENTRYPOINT []
CMD ["/opt/runner/execute", "--describe"]
