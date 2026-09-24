"""The administration console's own API: a relay to the director, and nothing else.

This process holds no credential and keeps no state. It verifies the token the
platform's edge forwards, relays it to the director when a screen needs an
answer, and hands the answer back unchanged. Whatever a person may see or
change here is decided by the director from the authorization graph.
"""

from fastapi import FastAPI

from app.api.routes import admin, cluster, credentials, extensions, health, session
from app.core.config import get_settings
from app.core.logging_middleware import RedactingAccessLogMiddleware
from app.extensions import loader

settings = get_settings()

app = FastAPI(title=settings.project_name, openapi_url=f"{settings.api_v1_str}/openapi.json")

extension_registry = loader.discover(settings.app_id)

app.add_middleware(RedactingAccessLogMiddleware)

app.include_router(health.router)
app.include_router(session.router, prefix=settings.api_v1_str)
app.include_router(cluster.router, prefix=settings.api_v1_str)
app.include_router(admin.router, prefix=settings.api_v1_str)
app.include_router(credentials.router, prefix=settings.api_v1_str)
app.include_router(extensions.router, prefix=settings.api_v1_str)

loader.mount_routes(extension_registry, app, settings.api_v1_str)
