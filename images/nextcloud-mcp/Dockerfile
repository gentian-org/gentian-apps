# MCP server sidecar for nextcloud-base — see profiles/nextcloud-base/profile.yaml
# (spec.sidecars) for how this is deployed and profiles/nextcloud-base/profile.yaml's
# postInstallJob for how its dedicated Nextcloud account is provisioned.
#
# Runs as a same-pod sidecar in the tenant namespace, whose NetworkPolicy blocks
# general internet egress by default — dependencies must be baked in at build
# time (this Dockerfile), never installed at container startup.
FROM python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4

RUN adduser -D -u 1000 mcp
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

USER mcp
EXPOSE 8765

LABEL org.opencontainers.image.title="Gentian Nextcloud MCP Sidecar" \
      org.opencontainers.image.description="MCP server exposing a Nextcloud tenant's files to AI agents"

CMD ["python3", "server.py"]
