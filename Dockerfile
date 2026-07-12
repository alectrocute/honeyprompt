# syntax=docker/dockerfile:1
FROM denoland/deno:2.9.2 AS base
WORKDIR /app

# Cache dependencies as their own layer for fast rebuilds.
COPY deno.json deno.lock* ./
COPY src ./src
RUN deno cache src/main.ts

# Durable event storage is writable by the non-root runtime user. A named
# volume mounted at /data inherits this ownership on first use.
RUN mkdir -p /data && chown deno:deno /data

# Non-root by default; the base image ships a `deno` user.
USER deno

# Config is mounted at runtime as a read-only volume.
ENV HONEYPROMPT_CONFIG=/etc/honeyprompt/honeyprompt.yaml
ENV HONEYPROMPT_EVENT_FILE=/data/events.jsonl
VOLUME ["/etc/honeyprompt", "/data"]
EXPOSE 80 2222 2323 2375 6379 8000 8001 9090

# When the panel is enabled, GET /healthz is an unauthenticated readiness probe.
# Wire it up in your orchestrator (Compose/K8s) where the panel address is known.

ENTRYPOINT ["deno", "run", \
  "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", \
  "src/main.ts"]
CMD ["run"]
