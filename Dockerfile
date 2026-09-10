# TAHAMTAN AI — merge + caption service
# Debian bookworm — ffmpeg with libass + fribidi + harfbuzz
# for correct Arabic/Persian/Urdu shaping, plus Noto fonts for
# all 13 supported languages.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fontconfig \
      fonts-noto-core \
      fonts-noto-ui-core \
      fonts-noto-cjk \
      fonts-noto-extra \
      fonts-noto-color-emoji \
      fonts-noto-cjk-extra \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
