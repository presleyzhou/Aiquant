# Vendored code notice

This directory contains a **partial, unmodified copy** of selected modules from
[`fincept-terminal` 2.0.8](https://pypi.org/project/fincept-terminal/) (MIT License, see `LICENSE`).

## Why vendored instead of `pip install fincept-terminal`

The upstream package declares `PyQt5==5.15.11` and `dearpygui==2.0.0` as hard requirements —
roughly 100 MB of desktop-GUI dependencies plus OpenGL system libraries that a headless
container has no use for. It also pins `numpy==2.2.6`, `requests==2.31.0`, `pandas==2.2.3`
and others exactly, which conflicts with the FastAPI/anthropic dependency tree.

Only the GUI-free modules that actually import and run are copied here. Package paths are
preserved verbatim so the upstream absolute imports
(`from fincept_terminal.Utils.Logging.logger import ...`) resolve with **zero source patching**.

## What is included

| Path | Upstream lines | Purpose |
|---|---|---|
| `Utils/Logging/logger.py` | 519 | Structured logger — stdlib only |
| `DatabaseConnector/DataSources/data_source_manager.py` | 1656 | Unified stock/forex/crypto/news/macro fetch layer with caching |
| `.../alpha_vantage_data/alpha_vantage_provider.py` | 2532 | Alpha Vantage API wrapper (async) |
| `.../imf_data/imf_provider.py` | 568 | IMF macroeconomic data (async) |
| `.../oced_data/oced_provider.py` + `constants.py` | 1311 | OECD macroeconomic data (async) |

## What is deliberately NOT included, and why

These modules ship in the upstream wheel but are broken or unusable. Verified against
`fincept_terminal-2.0.8-py3-none-any.whl`:

| Module | Problem |
|---|---|
| `Analytics/riskfoliolib_wrapper.py` | **0-byte file** — contains nothing |
| `Analytics/pyportfolioOpt_wrapper.py` | Class body truncated at ~line 295; from `def cla_optimization(self)` (line 297) onward every method is dedented to module level and sits outside `PyPortfolioOptAnalyticsEngine`. Also needs `PyPortfolioOpt`, `cvxpy`, `plotly`, `seaborn` — none declared in `requires_dist` |
| `Analytics/skfolio_wrapper.py` | Class intact, but requires `skfolio` (undeclared) |
| `Analytics/ext.py` | Requires `sentence_transformers` + `faiss` (undeclared) and a local service on `127.0.0.1:4567` |
| `DataSources/sec_data/sec_provider.py` | Imports `sec_data.utils.helpers`, `.utils.form4`, `.utils.parse_13f`, `.utils.frames`, `.utils.definitions` — **the `utils/` subpackage does not exist in the wheel**. `ImportError` on import |
| `DataSources/fmp_data/fmp_provider.py` | Not a provider class — a script with a hardcoded `SYMBOL = "TSLA"` that writes TXT files. Also contains a **hardcoded third-party API key** published in the wheel |
| `DashBoard/PortfolioTab/portfolio_business.py` | Module-level `import tkinter` / `from tkinter import filedialog` — fails in a headless container |

Portfolio optimisation and technical indicators are therefore implemented from scratch in
`app/services/` rather than reused from upstream.

## Undeclared dependency

The async providers all `import aiohttp`, which upstream omits from `requires_dist`.
It is declared explicitly in `backend/pyproject.toml`.

## Modifications

None. Files are byte-identical to the upstream wheel. Adaptation lives entirely in
`app/services/datasource.py`, which supplies a headless stub in place of the DearPyGui
`app` object (upstream only touches `self.app` inside `get_settings_manager()`, and every
access there is `hasattr`-guarded, so the stub degrades cleanly to the default data sources).
