# Kronos inference service — the same AIQUANT backend, with torch installed
# and the checkpoint baked into the image so the first request doesn't stall.
#
# Works as-is on HuggingFace Spaces (Docker SDK, listens on 7860), Fly.io,
# Railway, or any Docker host. See README.md in this directory.

FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Shallow-clone the app; pin to a commit with a build arg if you want
# reproducible rebuilds: --build-arg REPO_REF=<sha>
ARG REPO_URL=https://github.com/presleyzhou/Aiquant.git
ARG REPO_REF=main
# Bump CACHE_BUST (any value) to force a fresh clone when the builder reuses
# layers; Factory rebuild on HF Spaces normally clears the cache, but the
# runtime `git pull` below means a plain Restart already picks up new code.
ARG CACHE_BUST=2026-09-06
RUN echo "cache-bust ${CACHE_BUST}" && git clone --depth 1 --branch ${REPO_REF} ${REPO_URL} app-src

WORKDIR /srv/app-src/backend

# The root requirements.txt is Vercel-lean and omits the ASGI server on
# purpose — this container runs its own, so add uvicorn explicitly.
RUN pip install --no-cache-dir -r ../requirements.txt -r requirements-kronos.txt "uvicorn[standard]>=0.32" \
    # CPU-only torch is enough here and keeps the image several GB smaller.
    && pip install --no-cache-dir --force-reinstall torch --index-url https://download.pytorch.org/whl/cpu

# Bake the checkpoint into the image: cold starts then skip the ~100MB
# HuggingFace download entirely.
ENV HF_HOME=/srv/hf-cache
RUN python - <<'PY'
from vendor.kronos import Kronos, KronosTokenizer
KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
Kronos.from_pretrained("NeoQuasar/Kronos-small")
print("checkpoint cached")
PY

ENV KRONOS_DEVICE=cpu
# HF Spaces routes traffic to 7860; Fly/Railway respect $PORT at runtime.
EXPOSE 7860
# Pull the latest backend on every start (fast-forward only, never fails the
# boot): a Restart refreshes code; a rebuild is only needed for new packages.
CMD ["sh", "-c", "git -C /srv/app-src pull --ff-only --depth 1 || true; uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
