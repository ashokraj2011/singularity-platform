from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_path: str = "./data/context_memory.db"
    # M33 — context-memory routes summarization through the central LLM gateway.
    # Provider keys live ONLY on llm-gateway-service. The legacy
    # SUMMARIZER_PROVIDER / SUMMARIZER_MODEL env vars have been retired; the
    # gateway resolves the model via its alias catalog.
    llm_gateway_url: str = "http://llm-gateway:8001"
    llm_gateway_bearer: str = ""
    summarizer_model_alias: str = "mock"

    class Config:
        env_prefix = ""
        extra = "ignore"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        import os
        self.db_path = os.getenv("CONTEXT_MEMORY_DB", self.db_path)
        self.llm_gateway_url = os.getenv("LLM_GATEWAY_URL", self.llm_gateway_url)
        self.llm_gateway_bearer = os.getenv("LLM_GATEWAY_BEARER", self.llm_gateway_bearer)
        self.summarizer_model_alias = os.getenv("SUMMARIZER_MODEL_ALIAS", self.summarizer_model_alias)


settings = Settings()
