# Piston with its language packages baked in at build time, so the container
# never needs network access. Runs only under the Kata Containers runtime (see
# docs/runbooks/piston-kata.md and docs/plans/piston-runner.md).
FROM alpine:3.22@sha256:3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764 AS packages
RUN apk add --no-cache curl
WORKDIR /pkgs
# language version sha256 (from the Piston package index, reviewed 2026-10-01)
RUN set -eu; \
    while read -r language version sha; do \
      file="$language-$version.pkg.tar.gz"; \
      curl -fsSL -o "$file" "https://github.com/engineer-man/piston/releases/download/pkgs/$file"; \
      echo "$sha  $file" | sha256sum -c -; \
      mkdir -p "out/$language/$version"; \
      tar -xzf "$file" -C "out/$language/$version"; \
    done <<'EOF'
gcc 10.2.0 a3ffa0672b992ee772217c64080671f5a4ee1250fea19ac2c8d5205a5682bdb3
java 15.0.2 f695d4ae1a8c783a9bcdd31f23795a980d938e50260254cf6a95560622c092f7
node 20.11.1 69e009f54ca8118418c994945d9852f025ea212519ea3bf85188c2133b388243
python 3.12.0 abc40b3231fc7e713799da2cd79844545c72b3904a4d2ffcc28c4d133ed21d0b
EOF

FROM ghcr.io/engineer-man/piston@sha256:2f66b7456189c4d713aa986d98eccd0b6ee16d26c7ec5f21b30e942756fd127a
COPY --from=packages --chown=1001:1001 /pkgs/out/ /piston/packages/
# Reproduce what Piston's own package installer writes after extraction:
# the cached environment (.env) and the installed marker (.ppman-installed).
RUN set -eu; \
    for dir in /piston/packages/*/*/; do \
      env -i bash -c "cd '$dir' && source environment && env" \
        | grep -vE '^(PWD|OLDPWD|_|SHLVL)=' > "$dir.env"; \
      echo 0 > "$dir.ppman-installed"; \
      chown 1001:1001 "$dir.env" "$dir.ppman-installed"; \
    done
COPY --chmod=0555 entrypoint.sh /usr/local/bin/codestead-piston-entrypoint
ENTRYPOINT ["/usr/local/bin/codestead-piston-entrypoint"]
CMD []
