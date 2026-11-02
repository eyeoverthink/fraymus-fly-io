# syntax=docker/dockerfile:1.7
FROM node:24-slim
WORKDIR /app
# Story Shorts (server/shorts): free offline media tools. ffmpeg = clips/sfx/edit/captions/loudness, espeak-ng = offline voice,
# DejaVu = caption font. GPU stages (pictures, image-to-video, Whisper) run on the PC/Pi and upload per shot.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng fonts-dejavu-core && rm -rf /var/lib/apt/lists/*

# Piper (MIT, rhasspy/piper 2023.11.14-2 release: self-contained binary + onnxruntime + its own espeak-ng data) gives the
# voice stage a natural neural narrator on CPU (~20x real time, ~100-200 MB RAM). espeak-ng above stays as the fallback.
# Voice: en_US-ljspeech-medium from the official rhasspy/piper-voices repo. Trained from scratch on LJ Speech, which is
# public domain, so the narration can be used commercially (lessac/ryan/hfc/amy voices carry non-commercial dataset terms).
# Swap voices with PIPER_MODEL (a .onnx with its .onnx.json next to it, e.g. on /data/voices).
ARG PIPER_VERSION=2023.11.14-2
ADD --checksum=sha256:a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992 \
  https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz /tmp/piper.tgz
ADD --checksum=sha256:6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22 \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx /opt/piper-voices/en_US-ljspeech-medium.onnx
ADD --checksum=sha256:141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860 \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json /opt/piper-voices/en_US-ljspeech-medium.onnx.json
RUN printf '%s  %s\n' a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992 /tmp/piper.tgz \
    6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22 /opt/piper-voices/en_US-ljspeech-medium.onnx \
    141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860 /opt/piper-voices/en_US-ljspeech-medium.onnx.json | sha256sum -c - \
  && tar -xzf /tmp/piper.tgz -C /opt && rm /tmp/piper.tgz && chmod 644 /opt/piper-voices/* \
  && echo "It works." | /opt/piper/piper --model /opt/piper-voices/en_US-ljspeech-medium.onnx --output_file /tmp/t.wav && rm /tmp/t.wav
ENV PIPER_BIN=/opt/piper/piper PIPER_MODEL=/opt/piper-voices/en_US-ljspeech-medium.onnx
ENV NODE_ENV=production PORT=3001 DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --include=dev

COPY . .
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
RUN npx vite build

# SQLite (node:sqlite, Node 22.5+) and outputs live on the Fly volume mounted at /data
RUN mkdir -p /data
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server/index.ts"]
