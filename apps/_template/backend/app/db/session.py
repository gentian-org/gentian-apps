"""Database session helpers with tenant isolation (M26).

When your app stores tenant/user data, every query must scope by tenant_id.
Use get_tenant_session() in route handlers — never accept tenant_id from the client.
"""

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

from app.core.config import Settings, get_settings

# When DATABASE_URL is set, wire SQLModel/SQLAlchemy here:
# engine = create_engine(settings.database_url)
# SessionLocal = sessionmaker(bind=engine)


class TenantScopedSession:
    """Stub session — replace with real SQLModel session + tenant filter mixin."""

    def __init__(self, tenant_id: str) -> None:
        self.tenant_id = tenant_id

    def query(self, model: type, **filters: Any) -> list[Any]:
        """Example: always inject tenant_id into filters."""
        _ = model
        scoped = {"tenant_id": self.tenant_id, **filters}
        # return session.exec(select(model).where(...)).all()
        return [scoped]


@contextmanager
def get_tenant_session(
    tenant_id: str,
    settings: Settings | None = None,
) -> Generator[TenantScopedSession, None, None]:
    """Yield a DB session bound to the authenticated tenant."""
    _settings = settings or get_settings()
    if not _settings.database_url:
        yield TenantScopedSession(tenant_id=tenant_id)
        return

    session = TenantScopedSession(tenant_id=tenant_id)
    try:
        yield session
    finally:
        # session.close()
        pass
