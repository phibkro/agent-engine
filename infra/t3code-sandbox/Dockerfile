FROM docker.io/cloudflare/sandbox:0.12.5 AS sandbox

FROM docker.io/library/node:24.13.1-bookworm-slim

COPY --from=sandbox /container-server/sandbox /sandbox
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl git sqlite3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global t3@0.0.33

EXPOSE 8080
ENTRYPOINT ["/sandbox"]
