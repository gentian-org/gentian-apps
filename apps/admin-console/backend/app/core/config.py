from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    project_name: str = "Gentian Administration Console"
    api_v1_str: str = "/api/v1"
    environment: str = Field(default="local", alias="ENVIRONMENT")

    # Identifies this app to the extension loader. Plugins register under the
    # entry-point group "gentian.admin-console.<app_id>.plugins", so a plugin written for one
    # Gentian app is never loaded by another. Rename this when scaffolding.
    app_id: str = Field(default="gentian-admin-console", alias="APP_ID")

    tenant_id: str = Field(default="demo", alias="TENANT_ID")
    tenant_namespace: str = Field(default="tenant-demo", alias="TENANT_NAMESPACE")

    oidc_issuer: str | None = Field(default=None, alias="OIDC_ISSUER")
    oidc_client_id: str | None = Field(default=None, alias="OIDC_CLIENT_ID")
    oidc_client_secret: str | None = Field(default=None, alias="OIDC_CLIENT_SECRET")
    # The audience a bearer must carry. Under edge this is the director's,
    # because the zone's token is minted for the director; requiring it is
    # what stops a token the realm signed for some other purpose from being
    # taken for the zone's session. Falls back to the client id.
    oidc_audience: str | None = Field(default=None, alias="OIDC_AUDIENCE")

    # pkce: the bundle ran the code flow and sends its own token. edge: the
    # platform's Gateway holds the session and forwards the zone's token, and
    # this API relays it to the director when it needs an answer about the
    # caller. The platform sets this; a component does not choose it.
    auth_mode: str = Field(default="pkce", alias="AUTH_MODE")

    # Facts of the cluster this component runs in, set by the platform from
    # the profile's valueMapping.platform. None is chosen here.
    kernel_domain: str | None = Field(default=None, alias="KERNEL_DOMAIN")
    kernel_realm: str | None = Field(default=None, alias="KERNEL_REALM")
    zone_kind: str | None = Field(default=None, alias="ZONE_KIND")

    # Where the director answers, for a component that relays the caller's
    # token to it. Unset means the relay refuses with 503 and says so, rather
    # than guessing a host.
    director_url: str | None = Field(default=None, alias="DIRECTOR_URL")
    cluster_id: str | None = Field(default=None, alias="GENTIAN_CLUSTER_ID")
    # Where a person's own credential writes are relayed. Unset leaves the
    # Credentials screen answering that it is not configured, rather than
    # guessing at a host.
    credential_manager_url: str | None = Field(default=None, alias="CREDENTIAL_MANAGER_URL")

    auth_disabled: bool = Field(default=False, alias="AUTH_DISABLED")

    # Never use "*" in production — set explicit origins per tenant app host
    cors_origins: str = Field(default="http://localhost:5173", alias="BACKEND_CORS_ORIGINS")

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_edge(self) -> bool:
        return self.auth_mode == "edge"

    @property
    def expected_audience(self) -> str | None:
        """What a bearer must be for: the configured audience, else the client."""
        return self.oidc_audience or self.oidc_client_id

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod", "staging"}

    @model_validator(mode="after")
    def validate_production_security(self) -> "Settings":
        if self.is_production and self.cors_origins.strip() == "*":
            raise ValueError("BACKEND_CORS_ORIGINS must not be '*' in production (M9)")
        if self.is_production and self.auth_disabled:
            raise ValueError("AUTH_DISABLED must be false in production (M2)")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_dropin_config() -> dict:
    """Configuration contributed by L1 drop-in fragments.

    Kept separate from ``Settings`` on purpose. ``Settings`` is the app's own typed
    contract with its environment; drop-ins are operator- and tenant-supplied
    content that must never be able to override a security-relevant setting such as
    ``auth_disabled`` or ``cors_origins``. Read feature configuration from here;
    read security configuration from ``get_settings()``.
    """
    from app.core.dropins import load_dropins

    return load_dropins()
