# Always-on WhatsApp report bot. One Chromium (Playwright build) is used by both whatsapp-web.js and the renderer.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

# Chromium + its system libraries, and fonts used by the report.
RUN npx playwright install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends fonts-inter fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "dist/src/service.js"]
