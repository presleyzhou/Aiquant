from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- server ---
    cors_origins: str = "http://localhost:5173,http://localhost:8080"

    # --- Claude ---
    # Model catalogue: claude-opus-5 is the current Opus tier.
    anthropic_api_key: str | None = None
    claude_model: str = "claude-opus-5"
    # low | medium | high | xhigh | max — controls thinking depth and token spend.
    claude_effort: str = "high"
    claude_max_tokens: int = 16000

    # --- data sources (optional; yfinance needs no key) ---
    alpha_vantage_key: str | None = None

    # --- marketplace payments (optional) ---
    # With a Coinbase Commerce API key set, paid marketplace items check out
    # through real hosted crypto payments; without it the flow runs in a
    # clearly-labelled demo mode where no value moves.
    coinbase_commerce_api_key: str | None = None

    # --- market data ---
    quote_cache_seconds: int = 15
    ws_poll_seconds: float = 5.0

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def claude_enabled(self) -> bool:
        return bool(self.anthropic_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
