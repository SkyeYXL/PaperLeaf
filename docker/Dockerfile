FROM node:24-bookworm-slim

LABEL org.opencontainers.image.title="PaperLeaf" \
  org.opencontainers.image.version="0.0.3" \
  org.opencontainers.image.description="PaperLeaf v0.0.3 web reading archive with public API documentation" \
  org.opencontainers.image.documentation="/api-docs.html"

ENV NODE_ENV=production
# Chromium does not include CJK glyphs in the slim image. Keep the fonts in the
# runtime image so archived Chinese articles render as text instead of tofu in PDFs.
RUN apt-get update && apt-get install -y --no-install-recommends chromium fontconfig fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
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
