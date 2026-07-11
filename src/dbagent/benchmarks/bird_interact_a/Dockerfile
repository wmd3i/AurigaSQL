FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    postgresql-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/dbagent

# Install only third-party dependencies (parsed from pyproject) at build time.
# The dbagent source is copied into the running container at startup.
COPY pyproject.toml ./
RUN python -m pip install --upgrade pip \
  && python -m pip install $(python -c "import tomllib; print(' '.join(tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']))")

RUN mkdir -p /opt/dbagent/src
ENV PYTHONPATH=/opt/dbagent/src

CMD ["sleep", "infinity"]
