import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_without_an_issuer_it_does_not_start():
    with pytest.raises(ValidationError, match="OIDC_ISSUER is required"):
        Settings(_env_file=None, AUTH_DISABLED="false", OIDC_ISSUER="")


def test_auth_disabled_needs_no_issuer():
    settings = Settings(_env_file=None, AUTH_DISABLED="true", OIDC_ISSUER="")
    assert settings.auth_disabled


def test_the_extensions_report_needs_a_signed_in_person(monkeypatch):
    from fastapi.testclient import TestClient

    from app.core import config

    monkeypatch.setenv("AUTH_DISABLED", "false")
    monkeypatch.setenv("OIDC_ISSUER", "https://id.example.test/auth/realms/x")
    config.get_settings.cache_clear()
    from app.main import app

    try:
        assert TestClient(app).get("/api/v1/extensions").status_code == 401
    finally:
        config.get_settings.cache_clear()
