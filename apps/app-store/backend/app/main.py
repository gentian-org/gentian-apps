from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import catalogue, health, oauth, session, tenant_apps
from app.core.config import get_settings
from app.core.logging_middleware import RedactingAccessLogMiddleware

settings = get_settings()

app = FastAPI(
    title=settings.project_name,
    openapi_url=f"{settings.api_v1_str}/openapi.json",
)

app.add_middleware(RedactingAccessLogMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(oauth.router)
app.include_router(session.router, prefix=settings.api_v1_str)
app.include_router(catalogue.router, prefix=settings.api_v1_str)
app.include_router(tenant_apps.router, prefix=settings.api_v1_str)
