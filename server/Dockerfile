# Сервер Scan3D для Render (CPU, без GPU). COLMAP берём из Debian (собран без CUDA).
FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    QT_QPA_PLATFORM=offscreen \
    OMP_NUM_THREADS=2 \
    COLMAP_THREADS=2

RUN apt-get update \
 && apt-get install -y --no-install-recommends colmap libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/* \
 && colmap -h | head -n 3

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

ENV DATA_DIR=/tmp/scan3d-data
EXPOSE 10000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000} --timeout-keep-alive 75"]
