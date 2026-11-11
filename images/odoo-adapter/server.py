"""The Odoo adapter: an MCP server whose tools come from tool packs.

An adapter of odoo-base-ce (profiles/odoo/adapter/odoo-adapter-ce). It turns
Odoo's abilities into tools for a program that acts for a person, and holds no
credential of Odoo: the Authorization header of each MCP request goes on to
Odoo's JSON-2 API with the calls that request makes, so Odoo decides what the
call may see and change, as it would for that person in the browser.

The tools are the packs in ODOO_ADAPTER_PACKS (odoo_tools.py has the format),
offered only for the modules in ODOO_ADAPTER_MODULES when that is set. Each
tool carries its class (read, change, irreversible) as reviewed in its pack;
the MCP hints are derived from it and are no more than hints.

Streamable HTTP at /mcp, stateless: a request is answered by itself. /healthz
answers without Odoo.
"""

from __future__ import annotations

import contextlib
import logging
import os
from pathlib import Path
from typing import Any

import anyio
import uvicorn
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from odoo_tools import Odoo, Tool, ToolError, active, load_packs

log = logging.getLogger("odoo-adapter")

PACKS = Path(os.environ.get("ODOO_ADAPTER_PACKS", "/etc/odoo-adapter/packs"))
ODOO_URL = os.environ.get("ODOO_URL", "http://odoo:8069")
ODOO_DATABASE = os.environ.get("ODOO_DATABASE", "").strip() or None
PORT = int(os.environ.get("MCP_PORT", "8765"))


def modules_from_env(value: str | None) -> set[str] | None:
    """The active Odoo modules, or None for every pack's module. A list that is
    set but empty offers no tools."""
    if value is None:
        return None
    return {m.strip() for m in value.replace(",", " ").split() if m.strip()}


def describe(tool: Tool) -> types.Tool:
    return types.Tool(
        name=tool.key,
        title=tool.name.replace("-", " ").capitalize(),
        description=tool.description,
        inputSchema=tool.input_schema(),
        annotations=types.ToolAnnotations(
            readOnlyHint=tool.cls == "read",
            destructiveHint=tool.cls == "irreversible",
            idempotentHint=tool.operation in ("search", "read", "write"),
            openWorldHint=tool.cls == "irreversible",
        ),
        _meta={"gentianos.io/class": tool.cls, "gentianos.io/module": tool.module},
    )


def build(tools: list[Tool], odoo: Odoo) -> Server:
    server: Server = Server("odoo-adapter")
    by_key = {t.key: t for t in tools}

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [describe(t) for t in tools]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        tool = by_key.get(name)
        if tool is None:
            raise ToolError(f"there is no tool {name}")
        request = server.request_context.request
        authorization = request.headers.get("authorization", "") if isinstance(request, Request) else ""
        try:
            return await _in_thread(odoo.run, tool, arguments or {}, authorization)
        except ToolError:
            raise
        except Exception as exc:  # an answer, not a stack trace, for the caller
            log.exception("tool %s failed", name)
            raise ToolError(f"{name} failed: {exc.__class__.__name__}") from exc

    return server


async def _in_thread(fn, *args):
    return await anyio.to_thread.run_sync(fn, *args)


class _Endpoint:
    """The MCP endpoint as an ASGI app, so /mcp is answered without a redirect."""

    def __init__(self, manager: StreamableHTTPSessionManager):
        self.manager = manager

    async def __call__(self, scope, receive, send) -> None:
        await self.manager.handle_request(scope, receive, send)


def app(tools: list[Tool], odoo: Odoo) -> Starlette:
    manager = StreamableHTTPSessionManager(app=build(tools, odoo), stateless=True, json_response=True)

    async def health(_: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "tools": len(tools)})

    @contextlib.asynccontextmanager
    async def lifespan(_: Starlette):
        async with manager.run():
            yield

    return Starlette(
        routes=[Route("/healthz", health), Route("/mcp", endpoint=_Endpoint(manager), methods=["GET", "POST", "DELETE"])],
        lifespan=lifespan,
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    tools = active(load_packs(PACKS), modules_from_env(os.environ.get("ODOO_ADAPTER_MODULES")))
    log.info("offering %d tools: %s", len(tools), ", ".join(t.key for t in tools))
    uvicorn.run(app(tools, Odoo(ODOO_URL, ODOO_DATABASE)), host="0.0.0.0", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
