from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from gentian_app_runtime.extensions import loader
from gentian_app_runtime.extensions.routes import extensions_router

from app.api.routes import health, items, session
from app.core.auth import get_current_user
from app.core.config import get_settings
from app.core.logging_middleware import RedactingAccessLogMiddleware

settings = get_settings()

app = FastAPI(title=settings.project_name, openapi_url=f"{settings.api_v1_str}/openapi.json")

# Customization ladder L3 — discover plugins before routes are mounted so their
# routes appear in the OpenAPI schema. A failing plugin is recorded and reported
# at /api/v1/extensions; it never prevents startup.
extension_registry = loader.discover(settings.app_id)

app.add_middleware(RedactingAccessLogMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(session.router, prefix=settings.api_v1_str)
app.include_router(items.router, prefix=settings.api_v1_str)

# What is loaded here, and what plugins add, is for a signed-in person. Narrow
# this when an app has administrators of its own.
_signed_in = [Depends(get_current_user)]
app.include_router(
    extensions_router(lambda: extension_registry, dependencies=_signed_in),
    prefix=settings.api_v1_str,
)

# Plugin routes are namespaced under /api/v1/ext/<plugin-name> so two plugins
# cannot collide and a route's origin is obvious from its URL.
loader.mount_routes(extension_registry, app, settings.api_v1_str, dependencies=_signed_in)
