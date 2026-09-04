from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # The UI tells users to put keys in the PROJECT ROOT .env; uvicorn runs
    # from backend/, so honour both locations (the later entry wins when a
    # variable appears in both, making backend/.env the local override).
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    # --- server ---
    # Optional Sentry DSN — error monitoring activates only when set.
    sentry_dsn: str | None = None
    cors_origins: str = "http://localhost:5173,http://localhost:8080"

    # --- Claude ---
    # Model catalogue: claude-opus-5 is the current Opus tier.
    anthropic_api_key: str | None = None
    claude_model: str = "claude-opus-5"
    # low | medium | high | xhigh | max — controls thinking depth and token spend.
    claude_effort: str = "high"
    claude_max_tokens: int = 16000
    # Chat (AI 分析) rarely needs the full budget a strategy-design session
    # does; a tighter cap trims worst-case spend at zero quality cost.
    claude_chat_max_tokens: int = 8000
    # Cheaper tier for structured, evaluator-guarded tasks (news sentiment,
    # factor-expression generation). Opus stays on the reasoning-heavy paths.
    claude_model_light: str = "claude-sonnet-5"
    # Per-IP rate limits for token-spending endpoints (window in seconds).
    rl_chat_per_hour: int = 20
    rl_strategy_per_day: int = 5
    rl_mining_per_day: int = 5
    rl_evolve_per_day: int = 20
    rl_explain_per_day: int = 30
    rl_memo_per_day: int = 20
    rl_global_ai_per_day: int = 500

    # --- data sources (optional; yfinance needs no key) ---
    alpha_vantage_key: str | None = None

    # --- marketplace payments (optional) ---
    # Two independent rails, each real only when its key is present:
    #  * cards / Apple Pay / Google Pay (+ Alipay, WeChat Pay when enabled in
    #    the Stripe dashboard) via Stripe Checkout,
    #  * crypto (BTC / ETH / USDC / …) via Coinbase Commerce hosted checkout.
    # Without any key the flow runs in a clearly-labelled demo mode where no
    # value moves. Webhook secrets enable signed server-side confirmations.
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None
    # Comma list passed to Checkout; "card" alone also enables wallets.
    stripe_payment_methods: str = "card"
    coinbase_commerce_api_key: str | None = None
    coinbase_webhook_secret: str | None = None
    # Signs entitlement tokens and seller ownership. REQUIRED for tokens to
    # survive serverless cold starts; unset → random per process (dev only).
    marketplace_secret: str | None = None
    # Platform take on community sales (Stripe Connect application fee, or
    # what the platform keeps when settling crypto payouts manually).
    platform_fee_pct: float = 10.0
    # Public site URL used for payment return links when the client sends none.
    site_url: str = "https://aiquant-rust.vercel.app"
    # Upstash / Vercel KV REST credentials → durable listings + order ledger.
    # Unset → JSON file in the cache dir (ephemeral on serverless; labelled).
    kv_rest_api_url: str | None = None
    kv_rest_api_token: str | None = None
    rl_listings_per_day: int = 5
    rl_checkout_per_hour: int = 30

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
