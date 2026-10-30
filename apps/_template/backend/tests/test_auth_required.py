import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_without_an_issuer_it_does_not_start():
    with pytest.raises(ValidationError, match="OIDC_ISSUER is required"):
        Settings(_env_file=None, AUTH_DISABLED="false", OIDC_ISSUER="")


def test_auth_disabled_needs_no_issuer():
    settings = Settings(_env_file=None, AUTH_DISABLED="true", OIDC_ISSUER="")
    assert settings.auth_disabled
