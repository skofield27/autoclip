FROM node:20-slim

# ffmpeg for clipping, python3/pip for yt-dlp
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip curl ca-certificates && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p tmp clips

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
