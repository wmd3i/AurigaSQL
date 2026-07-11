FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    sqlite3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/dbagent

# Install only third-party dependencies (parsed from pyproject) at build time.
# The dbagent source is NOT baked in; it is copied into the running container at
# startup via `docker cp` so code changes never require an image rebuild.
COPY pyproject.toml ./
RUN python -m pip install --upgrade pip \
  && python -m pip install $(python -c "import tomllib; print(' '.join(tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']))")

# Source lands here at container start; keep it on the import path.
RUN mkdir -p /opt/dbagent/src
ENV PYTHONPATH=/opt/dbagent/src

CMD ["sleep", "infinity"]
