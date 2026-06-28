"""Database session helpers with tenant isolation (M26)."""

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

from app.core.config import Settings, get_settings


class TenantScopedSession:
    """Stub session — replace with real SQLModel session + tenant filter mixin."""

    def __init__(self, tenant_id: str) -> None:
        self.tenant_id = tenant_id

    def query(self, model: type, **filters: Any) -> list[Any]:
        _ = model
        scoped = {"tenant_id": self.tenant_id, **filters}
        return [scoped]


@contextmanager
def get_tenant_session(
    tenant_id: str,
    settings: Settings | None = None,
) -> Generator[TenantScopedSession, None, None]:
    _settings = settings or get_settings()
    if not _settings.database_url:
        yield TenantScopedSession(tenant_id=tenant_id)
        return

    session = TenantScopedSession(tenant_id=tenant_id)
    try:
        yield session
    finally:
        pass
