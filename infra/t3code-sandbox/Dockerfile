FROM docker.io/cloudflare/sandbox:0.12.5

USER root
RUN apt-get update \
  && apt-get install --yes --no-install-recommends fuse3 git sqlite3 squashfs-tools \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global t3@0.0.33
