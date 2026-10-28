FROM node:22-bookworm-slim
ARG DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn
RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends openssh-client python3 python3-pil ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
ENV HOST=0.0.0.0 PORT=8317 GATEWAY_DATA_DIR=/app/data
EXPOSE 8317
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8317/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
