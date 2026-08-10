FROM oven/bun:1.3.13-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG GIT_VERSION=1:2.39.5-0+deb12u2
ARG OPENSSH_SERVER_VERSION=1:9.2p1-2+deb12u7
ARG CA_CERTIFICATES_VERSION=20230311+deb12u1
ARG HERDR_URL=https://github.com/herdrdev/herdr/releases/download/v0.8.0/herdr-linux-x86_64
ARG HERDR_SHA256=b872ea7e40fa2cb17e857ac9b62b1bf26db7b403c622f5d2f3f5b35f6e9acd28
ARG OMP_URL=https://github.com/can1357/oh-my-pi/releases/download/v17.2.3/omp-linux-x64
ARG OMP_SHA256=baa58664ed4e510ca04cb756e278d6b75d4bcce562e1474c0c9337f525c6b3fa

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    "git=${GIT_VERSION}" \
    "openssh-server=${OPENSSH_SERVER_VERSION}" \
    "ca-certificates=${CA_CERTIFICATES_VERSION}" \
    curl=7.88.1-10+deb12u12 \
    xz-utils=5.4.1-0.2 \
  && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --proto '=https' --tlsv1.2 --output /usr/local/bin/herdr "${HERDR_URL}" \
  && printf '%s  %s\n' "${HERDR_SHA256}" /usr/local/bin/herdr | sha256sum --check --strict \
  && chmod 0755 /usr/local/bin/herdr
RUN curl --fail --location --proto '=https' --tlsv1.2 --output /usr/local/bin/omp "${OMP_URL}" \
  && printf '%s  %s\n' "${OMP_SHA256}" /usr/local/bin/omp | sha256sum --check --strict \
  && chmod 0755 /usr/local/bin/omp

WORKDIR /opt/work-engine
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY infra/project-container/herdr.toml /etc/herdr/herdr.toml
COPY infra/project-container/versions.json /opt/work-engine/infra/project-container/versions.json

RUN bun install --frozen-lockfile --ignore-scripts
RUN case "$(herdr --version)" in *0.8.0*) ;; *) exit 1 ;; esac
RUN case "$(omp --version)" in *17.2.3*) ;; *) exit 1 ;; esac
RUN herdr integration install omp \
  && herdr integration status > /opt/work-engine/herdr-integration.status \
  && test -s /opt/work-engine/herdr-integration.status \
  && case "$(cat /opt/work-engine/herdr-integration.status)" in *omp*) ;; *) exit 1 ;; esac
RUN test -x /opt/work-engine/bin/work \
  && case "$(/opt/work-engine/bin/work --version)" in *0.0.0*|*work-engine*) ;; *) exit 1 ;; esac

RUN useradd --system --create-home --home-dir /var/lib/work-engine --shell /usr/sbin/nologin work-engine-host \
  && mkdir --mode=0700 /run/work-engine /var/lib/work-engine/sessions \
  && chown --recursive work-engine-host:work-engine-host /run/work-engine /var/lib/work-engine \
  && mkdir --mode=0755 /run/sshd

ENV HERDR_CONFIG=/etc/herdr/herdr.toml
ENV WORK_ENGINE_RUNTIME_DIR=/run/work-engine
ENV WORK_ENGINE_HERDR_SOCKET=/run/work-engine/herdr.sock
ENV PATH=/opt/work-engine/bin:/usr/local/bin:/usr/bin:/bin

EXPOSE 8788
EXPOSE 22

ENTRYPOINT ["/usr/bin/bun", "/opt/work-engine/packages/session-host/src/container-entrypoint.ts"]
