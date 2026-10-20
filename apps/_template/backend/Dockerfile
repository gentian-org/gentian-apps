FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

ENV PYTHONUNBUFFERED=1
WORKDIR /app

# uv from its own image, pinned like every other base image; Dependabot
# moves the digest.
COPY --from=ghcr.io/astral-sh/uv:0.13.3@sha256:bee0a2a458fd956c5df7b8b4c5fed2257b0af34866e3da7b51db0be3acb375d1 /uv /usr/local/bin/uv

# The lockfile decides what is installed: --locked refuses a lockfile that
# does not match pyproject.toml instead of resolving anew, so the image
# holds exactly the versions the repository reviewed and the scanners saw.
# Dependencies first, the project after, so a code change does not reinstall
# them.
COPY pyproject.toml uv.lock /app/
RUN uv sync --locked --no-dev --no-install-project --no-editable

COPY app /app/app
RUN uv sync --locked --no-dev --no-editable
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
