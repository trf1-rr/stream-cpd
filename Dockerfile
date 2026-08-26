FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HLS_ROOT=/tmp/hls \
    PORT=8080

# ffmpeg faz a conversao RTSP -> HLS; curl baixa o hls.js e serve ao healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Embute o hls.js na imagem para que o player funcione mesmo sem internet
RUN curl -fsSL -o app/static/hls.min.js \
      https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js \
    && test -s app/static/hls.min.js

RUN mkdir -p /tmp/hls

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/healthz" || exit 1

# forma shell para expandir $PORT (Easypanel e outras PaaS injetam a porta)
CMD exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT}" --log-level info
