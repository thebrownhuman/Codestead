# syntax=docker/dockerfile:1.7
# Disposable, local-only toolbox for exercising the production backup scripts.
# It contains no credentials and is not part of the deployed service set.
FROM docker:29-cli@sha256:862099ada15c669000bef53aa4cb9d821262829f45b0dda2159ccb276443043b

RUN apk add --no-cache \
      age \
      bash \
      coreutils \
      diffutils \
      docker-cli-compose \
      findutils \
      git \
      grep \
      gzip \
      python3 \
      tar \
      util-linux

ENTRYPOINT ["/bin/bash"]
