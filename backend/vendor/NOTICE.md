# Vendored third-party code

## kronos/

Kronos — foundation model for financial K-line sequences.

- Source: https://github.com/shiyu-coder/Kronos (`model/` package, master @ 2026-08)
- License: MIT (see `kronos/LICENSE`)
- Files: `kronos.py`, `module.py`, `__init__.py` — preserved verbatim except one
  change: `from model.module import *` → `from .module import *` in `kronos.py`
  so the package imports relatively from `vendor.kronos`.
- Checkpoints download at runtime from HuggingFace (`NeoQuasar/Kronos-small`,
  `NeoQuasar/Kronos-Tokenizer-base`); they are not vendored.
- Runtime deps (torch/einops/…) are an optional extra: `requirements-kronos.txt`.
