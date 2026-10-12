# ffmpeg and yt-dlp are what download-video and the subtitle tools shell out to.
# Local whisper is not installed. Transcription uses OPENAI_API_KEY when it is set.
FROM node:22.17-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.17-bookworm-slim AS runtime

# Bookworm's yt-dlp package is from 2023 and fails on current YouTube.
# The upstream release file is a Python script, so it runs on Apple Silicon.
# Python comes from the Debian package; the script replaces that old binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 yt-dlp \
 && curl --http1.1 --retry 5 --retry-delay 2 -fsSL \
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
      -o /usr/local/bin/yt-dlp \
 && chmod 755 /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MCP_ENTRY=dist/index.js \
    TRANSCRIPT_MCP_STORAGE_DIR=/tmp/transcripts \
    YT_DLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY http-bridge.mjs ./http-bridge.mjs

USER node

EXPOSE 3000

CMD ["node", "http-bridge.mjs"]
