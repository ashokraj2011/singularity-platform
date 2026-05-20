from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_path: str = "./data/context_memory.db"
    # Context-memory asks MCP to perform summarization so MCP remains the only
    # service that talks to the LLM gateway during workflow execution.
    mcp_server_url: str = "http://mcp-server:7100"
    mcp_bearer_token: str = ""
    summarizer_model_alias: str = ""

    class Config:
        env_prefix = ""
        extra = "ignore"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        import os
        self.db_path = os.getenv("CONTEXT_MEMORY_DB", self.db_path)
        self.mcp_server_url = os.getenv("MCP_SERVER_URL", self.mcp_server_url)
        self.mcp_bearer_token = os.getenv("MCP_BEARER_TOKEN", self.mcp_bearer_token)
        self.summarizer_model_alias = os.getenv("SUMMARIZER_MODEL_ALIAS", self.summarizer_model_alias).strip()


settings = Settings()
