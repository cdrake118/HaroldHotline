# Explicit Dockerfile — Railway will use this instead of nixpacks.
# We need both ffmpeg and ffprobe at runtime, plus build tools for better-sqlite3.

FROM node:20-bookworm-slim

# System deps:
#   ffmpeg → audio/video composition + ffprobe (Debian's package ships both)
#   fonts-dejavu-core → DejaVuSans-Bold.ttf for studio drawtext captions
#   python3, make, g++ → required for better-sqlite3 native build
#   ca-certificates → HTTPS to Twilio/OpenAI/ElevenLabs
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      ca-certificates \
      python3 \
      make \
      g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install JS deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "server.js"]
