# AIQUANT TERMINAL

**[English README →](README.en.md)**

一个 Bloomberg 风格的 AI 量化研究网站：**美股与 A 股**双终端、跑马灯行情、K 线与技术指标、无前视偏差的策略回测、一个会**实际调用这些工具**再作答的 Claude 分析面板，以及一个带**加密货币结账**的策略 / AI 技能 / 数据源市场。

**线上地址**: https://aiquant-rust.vercel.app · **仓库**: https://github.com/presleyzhou/Aiquant

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
| `CLAUDE_MODEL_LIGHT` | `claude-sonnet-5` | 轻任务模型（新闻情绪、因子表达式生成），成本约为 Opus 的 1/5 |
| `CLAUDE_CHAT_MAX_TOKENS` | `8000` | AI 分析对话的单次输出上限（策略工坊仍用 `CLAUDE_MAX_TOKENS`） |
| `RL_CHAT_PER_HOUR` / `RL_STRATEGY_PER_DAY` / `RL_MINING_PER_DAY` / `RL_EVOLVE_PER_DAY` / `RL_MEMO_PER_DAY` | 20 / 5 / 5 / 20 / 20 | 每 IP 限流；`RL_GLOBAL_AI_PER_DAY`（500）为实例级每日 AI 调用熔断 |
| `ALPHA_VANTAGE_KEY` | 空 | 仅供内嵌的 Alpha Vantage provider 使用；yfinance 无需 key |
| `PANEL_PROVIDER_CRYPTO` | `binance` | 因子挖掘 / 流水线的数字货币日线面板：`binance` = Binance 公开 K 线为主源，Binance 未上币由 CoinGecko 补齐，Yahoo 兜底；`yahoo` 强制 Yahoo |
| `PANEL_PROVIDER_US` | `auto` | 美股日线面板：`auto` = 装了 AkShare（新浪财经前复权数据）就用 AkShare，否则 Yahoo；`akshare` / `yahoo` 强制。AkShare 约 100MB 依赖，不进 Vercel 包，本地 / Docker 用 `uv pip install -e '.[akshare]'` |
| `COINGECKO_FILL` / `COINGECKO_API_KEY` | `true` / 空 | 是否用 CoinGecko 补齐 Binance 未上的币；demo/pro key 可提高限额与历史长度（免费接口约 365 天） |
| `CORS_ORIGINS` | localhost | 仅当前后端不同源时才需要 |
| `KRONOS_ENABLED` | `auto` | Kronos K线预测；`auto` = 装了 torch 就启用，`0` 强制关闭 |
| `KRONOS_MODEL` | `NeoQuasar/Kronos-small` | 也可换 `NeoQuasar/Kronos-mini`（更快）或 `-base`（更准） |
| `KRONOS_REMOTE_URL` | 空 | 远程 Kronos 推理服务地址；本地无 torch 时（如 Vercel）自动转发 |
| `KRONOS_DEVICE` | 自动 | 强制推理设备：`cpu` / `mps` / `cuda:0` |

**Kronos K线预测（可选，本地/Docker）**：开源 K线基础模型
[shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos)（MIT，已 vendor 到
`backend/vendor/kronos/`）。需要 torch，故不进 Vercel 打包（超 225MB 上限），线上会显示"未启用"：

```bash
uv pip install -r backend/requirements-kronos.txt
```

首次预测会从 HuggingFace 下载 checkpoint（约 100MB），之后常驻内存。美股用工作日历、
低温采样（T=0.7）；数字货币用 7×24 日历、高温宽核采样（T=1.0, top_p=0.95）并多取一次采样平均。

**让 Vercel 线上也能预测**：把 `deploy/kronos-space/` 部署到 HuggingFace Spaces
（免费 CPU）或 Fly/Railway，再在 Vercel 配 `KRONOS_REMOTE_URL=<服务地址>` 即可 ——
Vercel 后端会把 `/api/kronos/*` 服务器侧转发过去（无 CORS、前端零改动）。
详见 [deploy/kronos-space/README.md](deploy/kronos-space/README.md)。

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
| POST | `/api/analytics/backtest` | 运行回测（含 `kronos_signal` 模型信号策略） |
| GET | `/api/marketplace/items?type=&q=` | 市场目录（策略/技能/数据，支持筛选搜索） |
| GET | `/api/marketplace/items/{id}` | 单个条目详情 |
| GET | `/api/kronos/status` | Kronos 预测是否可用、模型与设备 |
| POST | `/api/kronos/forecast` | K线预测 `{symbol, horizon?}`（美股/加密自动分流参数） |
| POST | `/api/kronos/evaluate` | 滚动历史评估：方向命中率 vs「永远看涨」基线 |
| POST | `/api/kronos/signal` | kronos_signal 策略的多空锚点（供回测引擎使用） |
| GET | `/api/factors/config` | 因子挖掘配置：标的池与默认参数 |
| POST | `/api/factors/mine` | Loop-engineered 因子挖掘（NDJSON 流式；支持跨次记忆与严格/标准/宽松门槛） |
| POST | `/api/factors/backtest` | 单因子 Top-N 等权组合回测（含成本与等权基准） |
| POST | `/api/factors/composite` | 多因子合成回测（等权 / 样本内 IC 加权） |
| POST | `/api/factors/check` | 因子体检：全窗/留出/近60日 IC（衰减监控与跨市场移植检验共用） |
| POST | `/api/factors/evolve` | 遗传算法因子进化（NDJSON 流：每代冠军 + 实时名人堂 + 留出期验证；`objective` = multi/ic） |
| POST | `/api/factors/explain` | 用轻量模型把因子表达式翻译成经济含义 / 风格 / 失效场景（24h 缓存） |
| GET | `/api/pipeline/config` | 端到端流水线配置：加权方案、起步因子、默认参数与取值范围 |
| POST | `/api/pipeline/run` | 端到端量化投资：多因子信号 → 组合构建（等权 / 信号加权 / 波动率倒数 / 最小方差 / 风险平价 / HRP / 均值-方差）→ 含成本回测 → 过拟合体检 → 风险归因 → 目标权重 |
| POST | `/api/pipeline/orders` | 调仓指令单：由组合规模与当前持仓生成到目标权重的买卖清单（整数股、不做空、含预估成本） |
| POST | `/api/pipeline/memo` | 投委会备忘录：轻量模型基于本次运行的数字给出 deploy / paper_first / iterate / reject 结构化结论（需 AI key） |
| POST | `/api/paper/track` | 模拟持仓前向跟踪（`kind` = strategy / factor / pipeline） |
| GET | `/api/ai/status` | AI 是否可用、模型/轻量模型、当日 token 用量与限流配置 |
| POST | `/api/ai/analyze` | 流式分析（NDJSON） |
| WS | `/ws/quotes` | 实时报价推送 |

```bash
curl localhost:8000/api/market/quote/AAPL
curl -X POST localhost:8000/api/analytics/backtest -H 'Content-Type: application/json' -d '{"symbol":"SPY","strategy":"ema_cross","period":"5y"}'
```

---

## 因子挖掘（Loop Engineering）

「因子挖掘」标签页实现了 2025 年 LLM 因子挖掘文献的迭代反馈架构（对标
[Chain-of-Alpha](https://arxiv.org/abs/2508.06312) 的生成/优化双链、
[AlphaAgent](https://arxiv.org/pdf/2502.16789) 的复杂度正则、QuantAgent 的经验累积）：

1. **生成**：Claude 每轮通过强制工具调用提交 N 个因子表达式（安全 DSL，手写解析器，绝不 eval）；标的池为 60 只美股（覆盖 11 个行业）/ 24 个币对；
2. **评估**：服务端确定性数学 —— 对 24 只美股 / 16 个币对的截面逐日计算 Rank IC，
   前 80% 样本内、后 20% 留出期，另查与已入选因子的冗余度与表达式复杂度；
3. **反馈**：结果压缩为指令式反馈（信号弱→增强、不稳→平滑、冗余→换结构、解析错误→原文引用）
   驱动下一轮生成 —— 每一轮都基于上一轮的结果优化。

诚实性设计：留出期永不进入反馈（模型无法拟合）；入选需留出期同号确认；挖不出就如实显示空因子库。

**遗传进化引擎（🧬，无需 AI key）**：同一页可切换到遗传算法自我进化——基因组即因子表达式树，
适应度 = |样本内 Rank IC| − 复杂度惩罚，与名人堂高相关者适应度减半（新颖度），每代 10% 精英 +
锦标赛选择 + 子树交叉/变异；可用因子库**热启动**（Warm-Start GP）。每代实时显示冠军因子的累计收益、
年化、夏普、最大回撤、IC 与进化代数；结束时留出期对名人堂逐个验证，入选者一键进因子库。
接口 `POST /api/factors/evolve`（NDJSON 流）。参考 AutoAlpha、Warm-Start GP、AlphaEvolve、AlphaForge。

**数据源冗余**：yfinance 为主源；失败时美股日线自动回退到 Stooq、加密回退到 Binance 公开 K 线接口
（`backend/app/services/fallback_data.py`），单点故障不再拖垮全站。

**本地数据备份**：页头 AI 状态芯片点开可见当日 token 用量与限流配置，并可一键导出/导入本浏览器内的
全部数据（自选、因子库、模拟持仓、预警），用于跨设备迁移。

## 端到端量化投资（Pipeline）

「端到端量化」标签页把研究到落地的完整链路串成一条可执行的流水线，六步走完，每一步的方法都有对应文献：

1. **标的池与数据**：默认复用因子挖掘的 60 只美股 / 24 个币对日线面板（磁盘缓存 + 数据源回退），每只标的带行业 / 板块标签；
   也可**自定义标的池**（8–40 只，可一键导入自选列表）并选 3 年或 5 年历史，自定义面板服务端缓存 6 小时；
   附**数据健康表**（每只标的覆盖率、缺口、起止日期、是否失效）；数据源可切换：数字货币默认 Binance 公开 K 线 + CoinGecko 补齐，
   美股装了 AkShare 时走新浪前复权数据，Yahoo 始终作为兜底（`backend/app/services/panel_providers.py`）；
2. **Alpha 信号**：从因子库勾选 1–8 个因子（或内置的反转 / 动量 / 低波 / 量能起步因子，或手输 DSL），逐因子截面排名后合成。
   默认**滚动 IC 加权**：t 日的权重只用 t 日之前已经"揭晓"的 IC（扩展窗均值、滞后一个预测期），整段回测对合成权重都是样本外；
   期间 IC 与零无法区分（|IC| < 0.005）的因子会被动态关闭而非翻转（AlphaForge 式动态选择）；也可选静态 IC（前 80%）或等权。给出复合信号的 **IC 衰减曲线**（1–20 日，Grinold-Kahn 信息期限）和 **分位数收益**（Qlib 式五分组、
   多空价差、单调性）与因子间相关矩阵；
3. **组合构建**：Top-N 入选后七种定权方案——等权、信号加权、波动率倒数、最小方差（投影梯度）、风险平价（等风险贡献不动点）、
   **层次风险平价 HRP**（López de Prado 2016，单链接聚类 + 递归二分）、**均值-方差（Grinold α = IC·σ·z）**；协方差用
   **Ledoit-Wolf 解析收缩强度**（Schäfer-Strimmer 闭式）向对角收缩。约束与交易规则：单票上限（不可行时留现金）、可选向 1/N 收缩
   （DeMiguel et al. 2009）、**持仓缓冲带**（已持有者在 Top-N+缓冲内继续持有，Qlib TopkDropout 思路）、**部分调仓**
   （Gârleanu-Pedersen 2013）、双边成本、可选目标波动率（只降杠杆、余额持现金，Harvey et al. 2018）；
4. **回测**：t 日收盘决策、t+1 日成交，换手计成本，再平衡之间权重随价格漂移。指标：总收益 / 年化 / 波动 / 夏普 / 索提诺 / 卡玛 /
   最大回撤 / 胜率、超额、β、跟踪误差、信息比率；前 80% 样本内与后 20% 留出期分列；月度热力图与年度表；同一信号下七种方案一键对比，每种方案相对等权的夏普差附 Ledoit-Wolf (2008) 区块自举 p 值——赢过 1/N 必须经得起噪声检验。
   **过拟合体检**：概率夏普 PSR、缩水夏普 DSR（N = 本次运行尝试过的配置数 + 浏览器里累计的历史运行数）、留出期 PSR、夏普 t 值
   对照 Harvey-Liu-Zhu 的 3.0 门槛、最短记录长度 MinTRL vs 实际天数、年换手倍数、**盈亏平衡成本**、滚动半年胜率；
   **参数敏感性**：同一信号在持仓数 × 调仓间隔的 3×3 邻域上重跑，稳健的结果是一片平台、过拟合的是一根尖峰（López de Prado），尖峰超过 0.5 自动告警；
5. **风险与归因**：最深五次回撤、个股贡献 Top/Bottom、有效持仓数（1/HHI）、上限触发比例、敞口曲线、60 日滚动 β、
   上/下行捕获比、CVaR 95%（对比基准）、**市场状态分层**（基准波动率三分位、趋势上下行）表现、
   **Brinson-Fachler 行业归因**（配置效应 / 选股效应 / 交互）、**容量分析**（平方根冲击模型 σ·√(成交额/20 日均额)，
   给出 1M–1B 规模下的冲击拖累与净超额、估算容量）；自动告警：留出期夏普崩塌、换手过高、再平衡太少、过度集中、
   覆盖不足、PSR < 0.9、t 值 < 2；
6. **部署**：最新一根完整 K 线上的目标权重表（含行业分布，可复制 CSV），一键部署到模拟持仓，从部署日起前向跟踪；
   **调仓指令单**：输入组合规模与当前持仓股数，生成先卖后买、整数股、不做空的交易清单，附参考价、换手、预估成本与调仓后现金（`POST /api/pipeline/orders`）；
   配置了 AI 时可生成**投委会备忘录**（`POST /api/pipeline/memo`，轻量模型只能引用页面上的数字，强制结构化输出：
   deploy / paper_first / iterate / reject + 优点 / 疑虑 / 下一步 / 统计局限）。

组合构建与风险分析是从零实现的纯 numpy/pandas（`backend/app/services/portfolio.py`，不依赖 scipy 或外部优化器），
流水线编排在 `backend/app/services/pipeline.py`，接口 `POST /api/pipeline/run`。文献：Ledoit & Wolf (2003/2004)、
López de Prado (2016; Bailey & LdP 2012/2014)、Grinold (1994) / Grinold & Kahn、Gârleanu & Pedersen (2013)、
DeMiguel-Garlappi-Uppal (2009)、Ledoit & Wolf (2008)、Harvey-Liu-Zhu (2016)、Brinson-Fachler (1985)、Qlib (Yang et al. 2020)。

## 设计要点

**回测不带前视偏差。** 信号在第 N 根 bar 产生，成交发生在第 N+1 根 bar 的**开盘价**，双边计手续费和滑点。第一根 bar 永远不可能成交，测试里有专门的不变量校验。每次回测都会同时给出同区间的买入持有基准 —— 大多数策略跑不赢它，报告应该如实呈现这一点。

**AI 拿到的是工具，不是预填的数据。** Claude 有 `get_quote`、`get_price_history`、`compute_indicator`、`run_backtest` 四个工具，自己决定调哪个。系统提示词明确要求：任何价格、指标值、绩效数字，都必须来自本轮对话里真实的工具返回，不许自己编。前端会把每一次工具调用和返回都展示出来，可以核对。

**AI 未配置时优雅降级。** 没有 API key 时，`/api/ai/status` 返回 `enabled: false`，前端显示一段说明，其余功能完全不受影响。

**Claude 安全分类器的拒答有兜底。** Opus 5 的分类器偶尔会误伤正常的金融措辞。代码默认开启服务端 fallback（`fallbacks: "default"`），被拒的请求会在同一次调用里换模型重试。如果账号没开这个 beta，会自动降级到标准接口且只降级一次，不会让整个 AI 功能挂掉。

**技术指标是重新实现的。** RSI 用 Wilder 平滑，且在「连续上涨、平均跌幅为 0」时返回 100 而不是 NaN。所有指标的预热期 NaN 在后端就丢掉了，前端不需要再过滤。

**A 股终端遵循本土惯例。** 独立标签页、独立自选列表（预置上证指数、贵州茅台、宁德时代等，带中文名），行情、K 线蜡烛、涨跌幅与回测统计全部**红涨绿跌** —— 与美股页的绿涨红跌互不干扰（通过 `--rise`/`--fall` CSS 变量按工作区切换）。数据来自 Yahoo（`.SS` 沪市 / `.SZ` 深市，延时约 15 分钟），后端零改动。

**行情条是真正的跑马灯。** 列表复制两份做无缝循环滚动，悬停暂停（保持可点击），`prefers-reduced-motion` 下退化为普通滚动条。报价变动时价格闪烁提示，闪烁颜色同样遵循所在市场的涨跌配色。

**市场支持买卖双边，支付走托管供应商，且诚实分层。** 买方：`STRIPE_SECRET_KEY` 开启银行卡 / Apple Pay / Google Pay（Stripe Checkout，`STRIPE_PAYMENT_METHODS` 可追加 `alipay,wechat_pay`），`COINBASE_COMMERCE_API_KEY` 开启数字货币（Coinbase Commerce 托管页，BTC / ETH / USDC…）；两条通道各自独立，卡号与私钥都不经过本站。支付确认后服务器签发 HMAC 权益凭证（`MARKETPLACE_SECRET`），付费社区内容的策略参数 / 因子表达式只凭凭证释放；`STRIPE_WEBHOOK_SECRET` / `COINBASE_WEBHOOK_SECRET` 启用签名校验的 webhook 入账。卖方：任何人可把自己的策略或因子库里的因子上架（免费或付费），收款选数字货币钱包（平台代收、扣 `PLATFORM_FEE_PCT` 后按周结算）或 Stripe Connect Express（开户链接一键跳转，成交时 Stripe 自动分账）。上架与订单账本存 Upstash / Vercel KV（`KV_REST_API_URL` + `KV_REST_API_TOKEN`），未配置时落到临时文件并在界面明示。两条通道都未配置时进入**明确标注的演示模式** —— 不展示收款地址、服务端永不伪造「已支付」、演示凭证永久带 demo 标记、演示成交不计入卖家销量。

**严格档加入稳健性门槛；组合级增量检验；最佳持有期自动采用。** 评估器为每个候选计算 4 段时间折的同号数与牛熊分段 IC，strict 档要求至少 3 段同号且牛熊皆成立。因子库新增「Δ」按钮：把该因子加入本市场其余因子的滚动 IC 合成，比较加入前后的组合夏普（`POST /api/factors/marginal`），直接回答「它对组合有没有增量」，比两两相关 0.7 更贴近实用。体检报告发现的最佳持有期会记入因子库，组合回测与上线到模拟持仓默认改用它作为再平衡周期。

**可交易性与多重比较进入录取条件。** 评估器对每个候选额外计算 Top-5 组合在再平衡周期上的换手率和扣 10 bp 双边成本后的五分层多空价差，扣成本为负的候选直接拒绝，理由会写进下一轮提示词（「平滑信号或拉长窗口」），遗传算法的适应度对这类个体乘 0.6。同时按累计尝试次数抬高显著性门槛：|t| 至少 2.0，每十倍尝试 +0.5，上限 3.0（Harvey–Liu–Zhu 的精神）；尝试次数跨会话累计存于浏览器并随记忆一起提交，进化引擎按本次评估数计算。多因子合成新增「滚动 IC 动态加权」：每个因子按滞后一个持有期的近 120 日 IC 调权（AlphaForge 思路），任何时点不使用未知的未来收益。

**因子体检报告（实盘前诊断）。** 每个因子一键生成 AlphaEval / Alphalens 式的实务诊断：五分层持有期收益与单调性、IC 随持有期（1/3/5/10/20/40）的衰减曲线与最佳持有期、Top-N 在再平衡周期上的换手与扣双边成本后的多空价差（每期与年化）、4 段滚动窗口 IC 与牛熊分段 IC、按持有期修正的 IC t 统计量（对照 Harvey–Liu–Zhu 的 t ≥ 3 门槛）。五个维度各给 A/B/C 评级，并输出可执行建议（换持有期、换手过高、扣成本为负、非单调、牛熊不对称、分段不稳、显著性不足）。接口 `POST /api/factors/analyze`；前端在因子库与进化实验室的每个因子旁提供「🩺 体检」。

**站内钱包（充值 → 余额购买 → 卖家入账 → 提现）。** 买家可先用银行卡或数字货币充值到站内余额（$1–$2000），再用余额一键购买；扣款即时、凭证即时签发，卖家钱包按扣除平台费后的净额入账，并可申请提现（冻结余额、站长人工打款，流水可查）。钱包账户就是浏览器持有的那把密钥（与卖家身份同一把，已含在数据导出中），服务器只存哈希；真实余额与演示余额分开记账、永不混用，演示余额买到的是演示凭证且不会给卖家入账。充值订单的入账对轮询与 webhook 幂等，重复回调不会重复记账。

**市场里的每个条目都接在真实引擎上。** 借鉴 FinceptTerminal「100+ 连接器 / 37 个 agent」的市场概念，但这里没有装饰品：策略条目携带的参数就是 `POST /api/analytics/backtest` 的合法请求体（有测试保证），点「在回测中运行」会切回终端并立即执行；AI 技能安装后进入 AI 面板的快捷提问（`{symbol}` 自动替换为当前标的）；数据源条目的状态是当前进程实时计算的（哪个在驱动站点、哪个已内嵌待接入、哪个缺 key）。也刻意**没有**编造安装量和评分——这是一个站长自营目录，不该假装是社区市场。安装状态存在浏览器 localStorage，没有引入数据库。

---

## 测试

前端另有 Playwright E2E 冒烟（`cd frontend && npm run e2e`）：全程 mock API、桩掉
WebSocket，无需后端与外网，CI 自动运行。


```bash
cd backend && .venv/bin/python -m pytest -q
```

全部离线测试，不联网、结果确定。覆盖指标的数学正确性（SMA 对齐手算均值、RSI 边界饱和、MACD 柱状图自洽、布林带上中下有序）、回测的核心不变量（无前视偏差、成本确实被扣、平盘市场不产生盈亏、末期未平仓头寸要盯市结算、numpy 标量不泄漏到 JSON），以及端到端流水线的组合构建数学（上限水填充、最小方差确实低于等权方差、风险平价的风险贡献相等）与诚实性不变量（当日信号不能赚当日收益、成本降低收益、换手只发生在再平衡日、目标波动率只降不加杠杆）。

---

## 已知限制

- **yfinance 不是流式数据源。** `/ws/quotes` 是服务端轮询（默认 5 秒）后推给浏览器。好处是浏览器只维持一条连接，且多客户端共享同一份报价缓存 —— 但它不是真正的 tick 级行情。
- **单标的策略回测只支持全仓多头。** 没有做空、没有仓位管理。多标的组合请走「端到端量化」流水线。
- **组合优化不含做空与杠杆。** 五种加权方案全部多头、总敞口 ≤ 100%；上游的优化 wrapper 是坏的（见 `NOTICE.md`），本项目的实现是从零写的。
- **Alpha Vantage / IMF / OECD 三个 provider 已内嵌可导入，但还没接到 API 上。** 目前所有接口走 yfinance。

---

## 免责声明

本项目仅供研究与教育用途，不构成投资建议。行情数据来自公开数据源，可能存在延迟或误差；回测结果不代表未来收益。
