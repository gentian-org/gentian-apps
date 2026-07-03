from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    project_name: str = "Gentian App Store"
    api_v1_str: str = "/api/v1"
    environment: str = Field(default="local", alias="ENVIRONMENT")

    tenant_id: str = Field(default="demo", alias="TENANT_ID")
    tenant_namespace: str = Field(default="tenant-demo", alias="TENANT_NAMESPACE")

    database_url: str | None = Field(default=None, alias="DATABASE_URL")

    oidc_issuer: str | None = Field(default=None, alias="OIDC_ISSUER")
    oidc_client_id: str | None = Field(default=None, alias="OIDC_CLIENT_ID")
    oidc_client_secret: str | None = Field(default=None, alias="OIDC_CLIENT_SECRET")
    oidc_audience: str | None = Field(default=None, alias="OIDC_AUDIENCE")

    openfga_api_url: str | None = Field(default=None, alias="OPENFGA_API_URL")
    openfga_store_id: str | None = Field(default=None, alias="OPENFGA_STORE_ID")

    gentian_deployments_path: str | None = Field(
        default=None, alias="GENTIAN_DEPLOYMENTS_PATH"
    )
    gentian_deployments_repo: str | None = Field(
        default=None, alias="GENTIAN_DEPLOYMENTS_REPO"
    )
    gentian_apps_repo: str = Field(
        default="https://github.com/gentian-org/gentian-apps",
        alias="GENTIAN_APPS_REPO",
    )
    gentian_apps_branch: str = Field(default="main", alias="GENTIAN_APPS_BRANCH")

    tenant_domain: str | None = Field(default=None, alias="TENANT_DOMAIN")

    gentian_commerce_enabled: bool = Field(default=False, alias="GENTIAN_COMMERCE_ENABLED")
    gentian_corp_api_url: str | None = Field(default=None, alias="GENTIAN_CORP_API_URL")
    gentian_corp_checkout_url: str | None = Field(
        default=None, alias="GENTIAN_CORP_CHECKOUT_URL"
    )

    install_mode: str = Field(default="gitops", alias="INSTALL_MODE")

    lifecycle_url: str | None = Field(
        default="http://gentian-os-lifecycle.gentian-system.svc.cluster.local:8082",
        alias="GENTIAN_LIFECYCLE_URL",
    )

    kernel_namespace: str = Field(default="platform-kernel", alias="KERNEL_NAMESPACE")

    auth_disabled: bool = Field(default=False, alias="AUTH_DISABLED")

    public_base_url: str | None = Field(default=None, alias="PUBLIC_BASE_URL")

    cors_origins: str = Field(default="http://localhost:5173", alias="BACKEND_CORS_ORIGINS")

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod", "staging"}

    @property
    def gentian_corp_checkout_base_url(self) -> str | None:
        if self.gentian_corp_checkout_url:
            return self.gentian_corp_checkout_url.rstrip("/")
        if self.gentian_corp_api_url:
            base = self.gentian_corp_api_url.rstrip("/")
            if base.endswith("/api/v1"):
                return base[: -len("/api/v1")]
            return base
        return None

    @model_validator(mode="after")
    def validate_production_security(self) -> "Settings":
        if self.is_production and self.cors_origins.strip() == "*":
            raise ValueError("BACKEND_CORS_ORIGINS must not be '*' in production (M9)")
        # Embedded in portal: AUTH_DISABLED=true while the shell gates tenant-admin access.
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
