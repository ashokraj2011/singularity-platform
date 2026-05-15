from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_path: str = "./data/context_memory.db"
    mcp_server_url: str = "http://localhost:7100"
    summarizer_provider: str = "mock"
    summarizer_model: str = "mock-summarizer"

    class Config:
        env_prefix = ""
        extra = "ignore"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        import os
        self.db_path = os.getenv("CONTEXT_MEMORY_DB", self.db_path)
        self.mcp_server_url = os.getenv("MCP_SERVER_URL", self.mcp_server_url)
        self.summarizer_provider = os.getenv("SUMMARIZER_PROVIDER", self.summarizer_provider)
        self.summarizer_model = os.getenv("SUMMARIZER_MODEL", self.summarizer_model)


settings = Settings()
