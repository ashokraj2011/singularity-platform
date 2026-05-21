from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_path: str = "./data/metrics_ledger.db"
    audit_gov_url: str | None = None
    audit_gov_service_token: str | None = None

    class Config:
        env_prefix = ""
        extra = "ignore"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        import os
        self.db_path = os.getenv("METRICS_LEDGER_DB", self.db_path)
        self.audit_gov_url = os.getenv("AUDIT_GOV_URL", self.audit_gov_url)
        self.audit_gov_service_token = os.getenv("AUDIT_GOV_SERVICE_TOKEN", self.audit_gov_service_token)


settings = Settings()
