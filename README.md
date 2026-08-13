# AIQUANT TERMINAL

一个 Bloomberg 风格的 AI 量化研究网站：实时行情、K 线与技术指标、无前视偏差的策略回测、一个会**实际调用这些工具**再作答的 Claude 分析面板，以及一个策略 / AI 技能 / 数据源的**市场**。

数据层复用了 [`fincept-terminal` 2.0.8](https://pypi.org/project/fincept-terminal/) 中 MIT 协议且可用的部分（详见 [`backend/fincept_terminal/NOTICE.md`](backend/fincept_terminal/NOTICE.md)）。

---

## 关于 fincept-terminal 的重要说明

`fincept-terminal` **不是 Web 框架**，它有两个形态，都是桌面端：

| | PyPI `fincept-terminal` 2.0.8 | GitHub `FinceptTerminal` v4.x |
|---|---|---|
| 技术栈 | Python + DearPyGui + PyQt5 | 原生 C++20 + Qt6 + 内嵌 Python |
| 协议 | MIT | **AGPL-3.0** |
| 形态 | 桌面 GUI | 单二进制桌面程序 |

本项目走的是**复用其 MIT 版数据层 + 自建 Web 服务**的路线：

- **没有** `pip install fincept-terminal` —— 它硬依赖 `PyQt5` 和 `dearpygui`（约 100MB + OpenGL 系统库），并把 `numpy`/`requests`/`pandas` 全部死锁到精确版本，与 FastAPI 生态冲突。
- 只**内嵌（vendor）了实际能跑的 GUI-free 模块**，保留原包路径，源码零改动。
- **没有**用 AGPL 的 C++ 版 —— 那会要求向所有访问者公开你的完整源码。

上游有相当一部分模块是坏的（0 字节文件、类体被截断、缺失子包、硬编码泄露的 API key、模块顶层 `import tkinter`）。每一项的具体问题都记录在 `NOTICE.md` 里。**技术指标和回测是本项目从零实现的**，没有复用上游的 `Analytics/`。

---

## 快速开始

### 方式一：本地开发（已实测跑通）

需要 Python ≥3.11（系统自带的 3.9 不行）和 Node ≥18。

```bash
cp .env.example .env
```

后端：

```bash
cd backend && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e '.[dev]' && .venv/bin/python -m uvicorn app.main:app --reload --port 8000
```

前端（另开一个终端）：

```bash
cd frontend && npm install && npm run dev
```

打开 http://localhost:5173 。Vite 会把 `/api` 和 `/ws` 代理到后端，所以前端代码里全部用同源相对路径，开发和生产环境无差异。

### 方式二：Docker

```bash
docker compose up --build
```

打开 http://localhost:8080 。

> ⚠️ 开发机上没有安装 Docker/OrbStack/Podman，所以 **Docker 这条路径没有实际运行验证过**。编排文件已写好，`docker-compose.yml` 的 YAML 解析和 Dockerfile 里风险最高的 `pip install .` 打包步骤都单独验证过了，但 `docker compose up` 本身没跑过。

### 方式三：Vercel（一个项目同时托管前后端）

仓库根目录已备好 `vercel.json`、`api/index.py` 和 `requirements.txt`：前端构建成静态资源，FastAPI 作为 serverless 函数挂在 `/api` 下。

```bash
npm i -g vercel
vercel login
vercel          # 预览环境
vercel --prod   # 生产环境
```

环境变量（`ANTHROPIC_API_KEY` 等）在 Vercel 控制台 → Settings → Environment Variables 里配置。

**Vercel 上的两个行为差异**（都已在代码里处理）：

1. **WebSocket 不可用** —— Vercel serverless 不支持 WS。前端在连接失败两次后自动切到 REST 轮询（12 秒一次），页头状态会显示「轮询模式」。本地和 Docker 部署仍走 WebSocket。
2. **AI 长流式受函数时长限制** —— `vercel.json` 已把 `maxDuration` 设为 300 秒；免费（Hobby）计划实际上限可能更低，超长的 AI 分析会被截断。

另外注意：yfinance 从数据中心 IP 段访问 Yahoo 偶尔会被限流，行情请求可能偶发失败，重试即可。

---

## 环境变量

全部可选。**不配任何东西网站也能跑** —— 行情、K 线、指标、回测都正常，只有 AI 面板会显示未启用。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 空 | 配上才会启用 AI 分析面板 |
| `CLAUDE_MODEL` | `claude-opus-5` | 也可用 `claude-sonnet-5`（更便宜）等 |
| `CLAUDE_EFFORT` | `high` | `low`/`medium`/`high`/`xhigh`/`max`，控制思考深度与花费 |
| `ALPHA_VANTAGE_KEY` | 空 | 仅供内嵌的 Alpha Vantage provider 使用；yfinance 无需 key |
| `CORS_ORIGINS` | localhost | 仅当前后端不同源时才需要 |

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查与 AI 启用状态 |
| GET | `/api/market/quote/{symbol}` | 单个标的报价 |
| GET | `/api/market/quotes?symbols=A,B` | 批量报价（单个失败不影响其余） |
| GET | `/api/market/candles/{symbol}?period=6mo` | OHLCV K 线 |
| GET | `/api/market/news` | 新闻（走内嵌的 DataSourceManager） |
| GET | `/api/market/sources` | 内嵌数据层健康状况与当前数据源映射 |
| GET | `/api/analytics/indicators` | 可用指标列表 |
| GET | `/api/analytics/indicator/{symbol}/{name}` | 计算指标 |
| POST | `/api/analytics/backtest` | 运行回测 |
| GET | `/api/marketplace/items?type=&q=` | 市场目录（策略/技能/数据，支持筛选搜索） |
| GET | `/api/marketplace/items/{id}` | 单个条目详情 |
| GET | `/api/ai/status` | AI 是否可用、用的哪个模型 |
| POST | `/api/ai/analyze` | 流式分析（NDJSON） |
| WS | `/ws/quotes` | 实时报价推送 |

```bash
curl localhost:8000/api/market/quote/AAPL
curl -X POST localhost:8000/api/analytics/backtest -H 'Content-Type: application/json' -d '{"symbol":"SPY","strategy":"ema_cross","period":"5y"}'
```

---

## 设计要点

**回测不带前视偏差。** 信号在第 N 根 bar 产生，成交发生在第 N+1 根 bar 的**开盘价**，双边计手续费和滑点。第一根 bar 永远不可能成交，测试里有专门的不变量校验。每次回测都会同时给出同区间的买入持有基准 —— 大多数策略跑不赢它，报告应该如实呈现这一点。

**AI 拿到的是工具，不是预填的数据。** Claude 有 `get_quote`、`get_price_history`、`compute_indicator`、`run_backtest` 四个工具，自己决定调哪个。系统提示词明确要求：任何价格、指标值、绩效数字，都必须来自本轮对话里真实的工具返回，不许自己编。前端会把每一次工具调用和返回都展示出来，可以核对。

**AI 未配置时优雅降级。** 没有 API key 时，`/api/ai/status` 返回 `enabled: false`，前端显示一段说明，其余功能完全不受影响。

**Claude 安全分类器的拒答有兜底。** Opus 5 的分类器偶尔会误伤正常的金融措辞。代码默认开启服务端 fallback（`fallbacks: "default"`），被拒的请求会在同一次调用里换模型重试。如果账号没开这个 beta，会自动降级到标准接口且只降级一次，不会让整个 AI 功能挂掉。

**技术指标是重新实现的。** RSI 用 Wilder 平滑，且在「连续上涨、平均跌幅为 0」时返回 100 而不是 NaN。所有指标的预热期 NaN 在后端就丢掉了，前端不需要再过滤。

**市场里的每个条目都接在真实引擎上。** 借鉴 FinceptTerminal「100+ 连接器 / 37 个 agent」的市场概念，但这里没有装饰品：策略条目携带的参数就是 `POST /api/analytics/backtest` 的合法请求体（有测试保证），点「在回测中运行」会切回终端并立即执行；AI 技能安装后进入 AI 面板的快捷提问（`{symbol}` 自动替换为当前标的）；数据源条目的状态是当前进程实时计算的（哪个在驱动站点、哪个已内嵌待接入、哪个缺 key）。也刻意**没有**编造安装量和评分——这是一个站长自营目录，不该假装是社区市场。安装状态存在浏览器 localStorage，没有引入数据库。

---

## 测试

```bash
cd backend && .venv/bin/python -m pytest -q
```

14 个离线测试，不联网、结果确定。覆盖指标的数学正确性（SMA 对齐手算均值、RSI 边界饱和、MACD 柱状图自洽、布林带上中下有序）和回测的核心不变量（无前视偏差、成本确实被扣、平盘市场不产生盈亏、末期未平仓头寸要盯市结算、numpy 标量不泄漏到 JSON）。

---

## 已知限制

- **yfinance 不是流式数据源。** `/ws/quotes` 是服务端轮询（默认 5 秒）后推给浏览器。好处是浏览器只维持一条连接，且多客户端共享同一份报价缓存 —— 但它不是真正的 tick 级行情。
- **回测只支持全仓多头。** 没有做空、没有仓位管理、没有组合。这是刻意收窄的范围。
- **组合优化没有实现。** 上游那几个 wrapper 是坏的（见 `NOTICE.md`），从零重写不在本次范围内。
- **Alpha Vantage / IMF / OECD 三个 provider 已内嵌可导入，但还没接到 API 上。** 目前所有接口走 yfinance。

---

## 免责声明

本项目仅供研究与教育用途，不构成投资建议。行情数据来自公开数据源，可能存在延迟或误差；回测结果不代表未来收益。
