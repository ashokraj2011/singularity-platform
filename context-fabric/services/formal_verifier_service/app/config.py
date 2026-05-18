from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    service_name: str = "formal-verifier-service"
    database_url: str = ""
    formal_verification_enabled: bool = False
    default_timeout_ms: int = 3000
    max_timeout_ms: int = 10000


settings = Settings()
