FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # The vendored fincept logger writes under $HOME; give it a writable one.
    HOME=/home/app

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /home/app --create-home app

WORKDIR /srv

# pyproject.toml is the single source of truth for dependencies — installing
# from it here means the image can never drift from the local dev environment.
# Both packages must be present before `pip install .` so setuptools can find
# them (see [tool.setuptools.packages.find] in pyproject.toml).
COPY pyproject.toml ./
COPY app ./app
COPY fincept_terminal ./fincept_terminal

RUN pip install --upgrade pip && pip install .

RUN chown -R app:app /srv /home/app
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
