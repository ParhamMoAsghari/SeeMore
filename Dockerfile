# seemore core image: Node 22 + metadata tools + the built React panel.
# Build: docker compose build seemore   (or: docker build -t seemore:local .)
# Build args let you use mirrors when Docker Hub / Alpine / npm are unreachable (see docs/iran.md):
#   NODE_IMAGE      base image                          default node:22-alpine
#   ALPINE_MIRROR   e.g. http://mirror.example.org      default: the official CDN
#   NPM_REGISTRY    e.g. https://registry.npmmirror.com default: registry.npmjs.org
#   WITH_RAR=1      download RARLAB rar (proprietary, not redistributed here) for RAR share links
#   RAR_URL         rar tarball (x64 by default; use the arm64 build on ARM hosts)
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS panel
ARG NPM_REGISTRY=
WORKDIR /src/panel
COPY panel/package.json panel/package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm ci --no-audit --no-fund
COPY panel/ ./
# Rollup is pinned to 4.68.7 (panel/package.json). 4.68.6's native parser rejects
# react-dom on Alpine/musl ("Code is nested too deeply") and fails this build.
RUN npm run build

FROM ${NODE_IMAGE}
ARG ALPINE_MIRROR=
ARG WITH_RAR=1
ARG RAR_URL=https://www.rarlab.com/rar/rarlinux-x64-712.tar.gz
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i -E "s#https?://dl-cdn.alpinelinux.org#${ALPINE_MIRROR}#" /etc/apk/repositories; fi \
 && apk add --no-cache ffmpeg file exiftool poppler-utils libarchive-tools uchardet gcompat libstdc++ libgcc tzdata wget \
 && ffprobe -version | head -1
RUN if [ "$WITH_RAR" = "1" ]; then \
      (wget -qO /tmp/rar.tgz "$RAR_URL" && tar xzf /tmp/rar.tgz -C /tmp && install -m 0755 /tmp/rar/rar /usr/local/bin/rar && rar 2>&1 | head -2) \
      || echo "WARNING: rar not installed; RAR share links will fail (set features.links_rar=false)"; \
      rm -rf /tmp/rar /tmp/rar.tgz; fi
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning NODE_ENV=production
WORKDIR /app
COPY app/ /app/
COPY --from=panel /src/app/public /app/public
USER node
CMD ["node", "bot.js"]
