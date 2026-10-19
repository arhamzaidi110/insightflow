from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore")

    analysis_port: int = Field(default=8000, ge=1, le=65535)
    max_upload_mb: int = Field(default=25, ge=1, le=250)
    analysis_service_token: str | None = None


settings = Settings()
