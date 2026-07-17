from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+asyncpg://lingxinext:lingxinext@localhost:5432/lingxinext"
    lingxigraph_postgres_url: str = "postgresql://lingxinext:lingxinext@localhost:5432/lingxinext"
    chainlit_auth_secret: SecretStr = Field(min_length=32)
    lingxi_master_key: SecretStr = Field(min_length=32)
    lingxi_admin_username: str = "admin"
    lingxi_admin_password: SecretStr = Field(min_length=12)
    lingxi_host: str = "0.0.0.0"
    lingxi_port: int = 8000
    lingxi_log_level: str = "INFO"

    @field_validator("database_url")
    @classmethod
    def async_postgres_only(cls, value: str) -> str:
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError("DATABASE_URL must use postgresql+asyncpg")
        return value

    @field_validator("lingxigraph_postgres_url")
    @classmethod
    def sync_postgres_only(cls, value: str) -> str:
        if not value.startswith(("postgresql://", "postgres://")):
            raise ValueError("LINGXIGRAPH_POSTGRES_URL must be a PostgreSQL DSN")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
