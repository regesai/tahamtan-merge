# TAHAMTAN AI — merge + caption service
# Debian-based image so ffmpeg ships with libass + fribidi + harfbuzz
# (correct Arabic/Persian/Urdu shaping) and we can install Noto fonts
# covering every one of the 13 supported languages.
FROM node:20-bullseye-slim

# ffmpeg (with libass/fribidi/harfbuzz), fontconfig, and Noto fonts:
#   fonts-noto-core  -> Latin, Cyrillic, Greek, Arabic, Devanagari, etc.
#   fonts-noto-cjk   -> Chinese / Japanese / Korean
#   fonts-noto-extra -> additional Noto faces
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
