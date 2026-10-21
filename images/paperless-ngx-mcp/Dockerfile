# MCP companion for paperless-ngx-ce -- see
# profiles/paperless-ngx/paperless-ngx-ce/profile.yaml (spec.extensions) for
# how it is deployed and the profile's post-install hook for how its own
# Paperless account is made.
#
# Runs in the tenant namespace, whose NetworkPolicy blocks general internet
# egress by default -- dependencies are baked in here, never installed at
# container start.
FROM python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4

RUN adduser -D -u 1000 mcp
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

USER mcp
EXPOSE 8765

LABEL org.opencontainers.image.title="Gentian Paperless-ngx MCP companion" \
      org.opencontainers.image.description="MCP server exposing a Paperless-ngx tenant's documents to AI agents"

CMD ["python3", "server.py"]
