from pydantic_settings import BaseSettings, SettingsConfigDict


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

    CORS_ORIGINS: list[str] = ["http://localhost:5175", "http://localhost:3000"]


settings = Settings()
