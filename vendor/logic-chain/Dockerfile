# Logic Chain server. Pure standard library: nothing to pip install.
FROM python:3.12-slim
WORKDIR /app
COPY app ./app
COPY config ./config
COPY run.py ./
# Bind inside the container; compose publishes it to 127.0.0.1 only.
ENV FRAYMUS_HOST=0.0.0.0 \
    FRAYMUS_PORT=8765 \
    FRAYMUS_DATA_DIR=/data \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8765
RUN useradd --create-home chain && mkdir -p /data && chown chain /data
USER chain
CMD ["python3", "run.py"]
