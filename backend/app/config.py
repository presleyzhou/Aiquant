from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # The UI tells users to put keys in the PROJECT ROOT .env; uvicorn runs
    # from backend/, so honour both locations (the later entry wins when a
    # variable appears in both, making backend/.env the local override).
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

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

    # --- Kronos K-line forecasting (optional; needs torch installed) ---
    # "auto" = enabled whenever torch imports (local dev / Docker with the
    # kronos extra); "0" = force off. Vercel ships without torch, so the
    # feature reports disabled there instead of breaking the deploy.
    kronos_enabled: str = "auto"
    kronos_model: str = "NeoQuasar/Kronos-small"
    kronos_tokenizer: str = "NeoQuasar/Kronos-Tokenizer-base"
    # Force a torch device ("cpu" | "mps" | "cuda:0"); empty = auto-detect.
    kronos_device: str | None = None
    # Base URL of a remote Kronos-capable deployment of this same backend
    # (e.g. an HF Space / Fly / Railway host). When torch is missing locally —
    # the Vercel case — /api/kronos/* proxies there, so production gets real
    # forecasts without torch in the serverless bundle.
    kronos_remote_url: str | None = None

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def claude_enabled(self) -> bool:
        return bool(self.anthropic_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
