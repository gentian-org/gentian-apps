# The Odoo adapter: an MCP server whose tools come from the tool packs the
# chart mounts at /etc/odoo-adapter/packs. See
# profiles/odoo/adapter/odoo-adapter-ce/profile.yaml for how it is installed.
#
# Runs in the tenant namespace, whose NetworkPolicy lets it reach Odoo and
# nothing else -- dependencies are baked in here, never installed at start.
FROM python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4

RUN adduser -D -u 1000 adapter
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY odoo_tools.py server.py ./

USER adapter
EXPOSE 8765

LABEL org.opencontainers.image.title="Gentian Odoo adapter" \
      org.opencontainers.image.description="MCP server turning Odoo into tools, from tool packs, with the caller's own credential"

CMD ["python3", "server.py"]
