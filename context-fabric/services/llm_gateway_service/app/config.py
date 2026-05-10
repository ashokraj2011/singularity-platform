from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_path: str = "./data/llm_gateway.db"
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_app_name: str = "Context Fabric"
    openrouter_site_url: str = "http://localhost:8000"
    openai_compatible_api_key: str = ""
    openai_compatible_base_url: str = "https://api.openai.com/v1"
    ollama_base_url: str = "http://localhost:11434"

    class Config:
        env_prefix = ""
        extra = "ignore"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        import os
        self.db_path = os.getenv("LLM_GATEWAY_DB", self.db_path)


settings = Settings()
