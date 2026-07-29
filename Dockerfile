# Playwright image ships with Chromium and all required system libs.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080

# Install FFmpeg for encoding captured frames.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/tmp && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 8080
CMD ["node", "src/server.js"]