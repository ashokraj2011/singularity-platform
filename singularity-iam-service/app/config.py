import os
from urllib.parse import urlparse

from pydantic_settings import BaseSettings, SettingsConfigDict


PROD_ENVS = {"prod", "production", "staging"}
KNOWN_DEV_DEFAULTS = {
    "Admin1234!",
    "change-me-in-production",
    "change-me-now",
    "changeme_dev_only_min_32_chars_long!!",
}


def _is_prod_env() -> bool:
    return any(
        os.environ.get(name, "").strip().lower() in PROD_ENVS
        for name in ("APP_ENV", "ENVIRONMENT", "NODE_ENV", "SINGULARITY_ENV")
    )


def _assert_prod_secret(name: str, value: str | None, min_length: int = 32) -> None:
    if not _is_prod_env():
        return
    normalized = (value or "").strip()
    if (
        len(normalized) < min_length
        or normalized in KNOWN_DEV_DEFAULTS
        or normalized.lower().startswith(("change-me", "changeme", "dev-", "test-"))
    ):
        raise RuntimeError(f"{name} must be set to a strong non-default value in production")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "postgresql+asyncpg://singularity:singularity@localhost:5433/singularity_iam"
    # Dev fallback aligned with docker-compose + the laptop bridge so a device
    # token IAM signs verifies at context-api's bridge when JWT_SECRET is unset.
    # ALWAYS override in any real deployment.
    JWT_SECRET: str = "changeme_dev_only_min_32_chars_long!!"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 60

    LOCAL_SUPER_ADMIN_EMAIL: str = "admin@singularity.local"
    LOCAL_SUPER_ADMIN_PASSWORD: str = "change-me-now"

    # IAM_AUTH_MODE controls how humans authenticate to IAM:
    #   local — seeded/local password accounts, suitable for development
    #   oidc  — external OpenID Connect identity provider, production SSO path
    IAM_AUTH_MODE: str = "local"
    OIDC_ISSUER_URL: str | None = None
    OIDC_CLIENT_ID: str | None = None
    OIDC_CLIENT_SECRET: str | None = None
    OIDC_REDIRECT_URI: str | None = None
    OIDC_SCOPES: str = "openid email profile"
    OIDC_SUBJECT_CLAIM: str = "sub"
    OIDC_EMAIL_CLAIM: str = "email"
    OIDC_NAME_CLAIM: str = "name"
    OIDC_ALLOWED_DOMAINS: str = ""
    OIDC_ADMIN_EMAILS: str = ""

    CORS_ORIGINS: list[str] = ["http://localhost:5175", "http://localhost:3000"]


settings = Settings()
_assert_prod_secret("JWT_SECRET", settings.JWT_SECRET)
_assert_prod_secret("LOCAL_SUPER_ADMIN_PASSWORD", settings.LOCAL_SUPER_ADMIN_PASSWORD, min_length=12)


def _require_https_url(name: str, raw: str | None) -> None:
    parsed = urlparse((raw or "").strip())
    if parsed.scheme != "https" or not parsed.netloc:
        raise RuntimeError(f"{name} must be an https URL")


def _validate_sso_settings() -> None:
    mode = settings.IAM_AUTH_MODE.strip().lower()
    if mode not in {"local", "oidc"}:
        raise RuntimeError("IAM_AUTH_MODE must be local or oidc")

    if mode != "oidc":
        return

    missing = [
        name
        for name in ("OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI")
        if not (getattr(settings, name) or "").strip()
    ]
    if missing:
        raise RuntimeError(f"IAM_AUTH_MODE=oidc requires {', '.join(missing)}")
    _require_https_url("OIDC_ISSUER_URL", settings.OIDC_ISSUER_URL)
    _require_https_url("OIDC_REDIRECT_URI", settings.OIDC_REDIRECT_URI)
    _assert_prod_secret("OIDC_CLIENT_SECRET", settings.OIDC_CLIENT_SECRET)


_validate_sso_settings()
