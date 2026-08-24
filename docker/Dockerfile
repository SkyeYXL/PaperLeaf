FROM node:24-bookworm-slim

ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*
ENV PAPERLEAF_PDF_BROWSER=/usr/bin/chromium
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
COPY public ./public

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3080/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]
