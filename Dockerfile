# syntax=docker/dockerfile:1.7
FROM ghcr.io/astral-sh/uv:0.11.4 AS uvbin

FROM python:3.13-slim AS builder
COPY --from=uvbin /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

COPY pyproject.toml uv.lock README.md ./
COPY vendor/LingxiGraph ./vendor/LingxiGraph
COPY app ./app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim AS runtime
RUN groupadd --gid 10001 lingxi && useradd --uid 10001 --gid 10001 --create-home lingxi
WORKDIR /app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CHAINLIT_APP_ROOT=/app

COPY --from=builder --chown=10001:10001 /app/.venv /app/.venv
COPY --chown=10001:10001 app ./app
COPY --chown=10001:10001 .chainlit ./.chainlit
COPY --chown=10001:10001 chainlit.md ./chainlit.md
COPY --chown=10001:10001 public ./public

USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
