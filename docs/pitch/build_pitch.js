// Investor pitch deck for AIQUANT TERMINAL — 10-minute 路演 + Q&A appendix.
// node docs/pitch/build_pitch.js  → docs/pitch/AIQUANT-路演.pptx
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const Fi = require("react-icons/fi");

const NAVY = "0B1020", PANEL = "121A2E", INK = "13213A", CYAN = "0FA8C9", CYAN_L = "3BE0FF", VIOLET = "8B78FF", GREY = "8A9AB0", GREY_D = "5E6E86",
  WHITE = "FFFFFF", AMBER = "F0B429", GREEN = "2ECC8A", RED = "FF5C7A", MIST = "C8D6E6", LIGHT = "EEF4FA", CARD = "F4F8FC";
const F = "Microsoft YaHei";
const SHOTS = __dirname + "/../lecture/shots";

async function icon(name, color, size = 256) {
  const svg = renderToStaticMarkup(React.createElement(Fi[name], { size, color: `#${color}`, strokeWidth: 1.7 }));
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}
async function shot(file, crop) {
  let img = sharp(`${SHOTS}/${file}`);
  const meta = await img.metadata();
  let w = meta.width, h = meta.height;
  if (crop) {
    const left = Math.round((crop.x0 ?? 0) * w), top = Math.round((crop.y0 ?? 0) * h);
    const width = Math.round(((crop.x1 ?? 1) - (crop.x0 ?? 0)) * w), height = Math.round(((crop.y1 ?? 1) - (crop.y0 ?? 0)) * h);
    img = img.extract({ left, top, width, height }); w = width; h = height;
  }
  const buf = await img.resize({ width: Math.min(w, 1600) }).png({ compressionLevel: 9 }).toBuffer();
  return { data: "image/png;base64," + buf.toString("base64"), aspect: w / h };
}

(async () => {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";
  pres.title = "AIQUANT TERMINAL 路演";
  const TOTAL = 14;

  const names = ["FiCpu", "FiRefreshCw", "FiShield", "FiShoppingBag", "FiTrendingUp", "FiTarget", "FiLayers", "FiActivity", "FiDatabase", "FiLock", "FiCheckCircle",
    "FiAlertTriangle", "FiZap", "FiUsers", "FiDollarSign", "FiGlobe", "FiBarChart2", "FiClock", "FiGitBranch", "FiEye", "FiAward", "FiCreditCard", "FiRepeat",
    "FiBookOpen", "FiServer", "FiFileText", "FiPlayCircle", "FiSearch", "FiBriefcase", "FiFlag", "FiMail", "FiKey", "FiSliders", "FiInbox"];
  const TONES = { cyan: CYAN, light: CYAN_L, violet: VIOLET, white: WHITE, amber: AMBER, green: GREEN, red: RED, ink: INK, grey: GREY };
  const ICON = {};
  for (const n of names) for (const [t, c] of Object.entries(TONES)) ICON[`${n}:${t}`] = await icon(n, c);

  const SH = {
    terminal: await shot("terminal.png"),
    mining: await shot("mining.png", { y1: 0.5 }),
    report: await shot("report.png", { y1: 0.30 }),
    library: await shot("library.png", { y1: 0.38 }),
    portfolio: await shot("portfolio.png", { y0: 0.545, y1: 0.985 }),
    paper: await shot("paper.png", { y1: 0.66 }),
    market: await shot("market.png", { y0: 0.05, y1: 0.99 }),
    gp: await shot("gp-progress.png", { y1: 0.5 }),
  };

  // ---------- helpers
  const dots = (s, color) => { for (let i = 0; i < 14; i++) for (let j = 0; j < 8; j++)
    s.addShape(pres.shapes.OVAL, { x: 0.35 + i * 0.7, y: 0.35 + j * 0.7, w: 0.035, h: 0.035, fill: { color }, line: { color, width: 0 } }); };
  const dark = (s) => { s.background = { color: NAVY }; dots(s, "1B2B48"); };
  const light = (s) => { s.background = { color: WHITE }; };
  const title = (s, text, sub, onDark = false) => {
    s.addText(text, { x: 0.5, y: 0.32, w: 9, h: 0.65, fontFace: F, fontSize: 24, bold: true, color: onDark ? WHITE : INK, isTextBox: true, margin: 0, valign: "middle" });
    if (sub) s.addText(sub, { x: 0.5, y: 0.93, w: 9, h: 0.38, fontFace: F, fontSize: 12, color: onDark ? MIST : GREY_D, isTextBox: true, margin: 0 });
  };
  const footer = (s, n, onDark = false) => s.addText(`AIQUANT TERMINAL · aiquant-rust.vercel.app · ${n}/${TOTAL}`, { x: 0.5, y: 5.25, w: 9, h: 0.25, fontFace: F, fontSize: 8.5, color: onDark ? GREY_D : GREY, isTextBox: true, margin: 0, align: "right" });
  const circ = (s, name, tone, x, y, d, bg) => {
    s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: bg }, line: { color: bg, width: 0 } });
    s.addImage({ data: ICON[`${name}:${tone}`], x: x + d * 0.24, y: y + d * 0.24, w: d * 0.52, h: d * 0.52 });
  };
  const frame = (s, sh, x, y, w, caption, onDark = false) => {
    const h = w / sh.aspect;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x - 0.06, y: y - 0.06, w: w + 0.12, h: h + 0.12, fill: { color: onDark ? "1A2640" : "DCE5F0" }, line: { color: onDark ? "27395C" : "C5D3E3", width: 0.75 }, rectRadius: 0.08, shadow: { type: "outer", blur: 6, offset: 2, angle: 90, color: "000000", opacity: 0.35 } });
    s.addImage({ data: sh.data, x, y, w, h });
    if (caption) s.addText(caption, { x, y: y + h + 0.06, w, h: 0.28, fontFace: F, fontSize: 8.5, color: onDark ? GREY : GREY_D, isTextBox: true, margin: 0, italic: true });
    return h;
  };
  // card with icon circle, header, body (light background)
  const card = (s, x, y, w, h, iconName, tone, head, body, opts = {}) => {
    const bg = opts.bg ?? CARD, fg = opts.fg ?? INK, bodyColor = opts.body ?? "33465F";
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: bg }, line: { color: opts.line ?? bg, width: 0.75 }, rectRadius: 0.1 });
    circ(s, iconName, tone, x + 0.18, y + 0.18, 0.46, opts.circle ?? WHITE);
    s.addText(head, { x: x + 0.74, y: y + 0.18, w: w - 0.9, h: 0.46, fontFace: F, fontSize: opts.headSize ?? 13, bold: true, color: fg, isTextBox: true, margin: 0, valign: "middle" });
    s.addText(body, { x: x + 0.18, y: y + 0.74, w: w - 0.36, h: h - 0.86, fontFace: F, fontSize: opts.bodySize ?? 10.5, color: bodyColor, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 3 });
  };
  const stat = (s, x, y, w, big, label, color, onDark) => {
    s.addText(big, { x, y, w, h: 0.7, fontFace: F, fontSize: 34, bold: true, color, isTextBox: true, margin: 0, align: "center", valign: "bottom" });
    s.addText(label, { x, y: y + 0.72, w, h: 0.62, fontFace: F, fontSize: 10, color: onDark ? MIST : GREY_D, isTextBox: true, margin: 0, align: "center", valign: "top" });
  };
  const bullets = (items, size = 11.5, color = INK) => items.map((t, i) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: i < items.length - 1, fontFace: F, fontSize: size, color, paraSpaceAfter: 5 } }));
  const notes = (s, t) => s.addNotes(t);

  // ================================================================ 1 cover
  {
    const s = pres.addSlide(); dark(s);
    s.addShape(pres.shapes.RECTANGLE, { x: 5.6, y: 0, w: 4.4, h: 5.625, fill: { color: "0E1730" }, line: { color: "0E1730", width: 0 } });
    frame(s, SH.terminal, 5.95, 1.55, 3.75, null, true);
    s.addImage({ data: ICON["FiCpu:light"], x: 0.6, y: 0.75, w: 0.7, h: 0.7 });
    s.addText("AIQUANT TERMINAL", { x: 0.6, y: 1.55, w: 4.8, h: 0.75, fontFace: F, fontSize: 34, bold: true, color: WHITE, isTextBox: true, margin: 0 });
    s.addText("让 AI 挖出可交易的 Alpha，\n并让它经得起检验、卖得出去。", { x: 0.6, y: 2.3, w: 4.8, h: 1.0, fontFace: F, fontSize: 16.5, color: CYAN_L, isTextBox: true, margin: 0 });
    s.addText("AI 投研一站式网站：行情终端 · 无前视回测 · AI 因子挖掘闭环 · 端到端量化流水线 · 策略与因子交易市场", { x: 0.6, y: 3.4, w: 4.7, h: 0.75, fontFace: F, fontSize: 11, color: "AFC3DA", isTextBox: true, margin: 0 });
    s.addText("项目路演 · 2026 年 9 月 · 主讲：Presley Zhou", { x: 0.6, y: 4.55, w: 4.8, h: 0.3, fontFace: F, fontSize: 10.5, color: GREY, isTextBox: true, margin: 0 });
    s.addText("aiquant-rust.vercel.app", { x: 0.6, y: 4.85, w: 4.8, h: 0.3, fontFace: F, fontSize: 10.5, color: AMBER, isTextBox: true, margin: 0 });
    notes(s, "【0:00–0:30】开场。一句话：AIQUANT 是一个已经上线运行的 AI 投研网站——它让 AI 提出投资因子，用一套严格的样本外检验把噱头筛掉，再把通过检验的信号变成交易单，并允许研究者把它挂到市场上卖。今天 10 分钟讲三件事：为什么现在做、我们做了什么、为什么值得投。\n提示：全程强调「已上线、可演示」，不要讲开发过程中的困难。");
  }

  // ================================================================ 2 problem
  {
    const s = pres.addSlide(); light(s);
    title(s, "AI 让「想法」变得廉价，「可信的验证」反而更贵了", "投研工作流的三个断点");
    const items = [
      ["FiZap", AMBER, "想法过剩，验证滞后", "一个 LLM 一分钟能写出 100 条因子表达式；但要判断哪一条能赚钱，研究员仍在 Excel、脚本和回测框架之间手工搬运数据，一条因子要半天。"],
      ["FiAlertTriangle", RED, "过拟合成了行业默认", "试得越多，随机撞中的「假信号」越多；绝大多数回测漂亮的因子扣掉交易成本、换手和样本外衰减之后归零。看过 1000 条因子却没有多重检验的纠正，等于没看。"],
      ["FiEye", VIOLET, "上线之后没有人盯", "信号一旦上线，回测与实盘的差距悄悄拉大，没有系统持续复检、报警，直到亏损才发现。个人与小团队更买不起每年 2 万美元级别的终端。"],
    ];
    items.forEach(([ic, tone, head, body], i) => {
      const x = 0.5 + i * 3.1;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.5, w: 2.9, h: 3.35, fill: { color: CARD }, line: { color: "E1E9F2", width: 0.75 }, rectRadius: 0.12 });
      s.addShape(pres.shapes.OVAL, { x: x + 0.25, y: 1.75, w: 0.62, h: 0.62, fill: { color: tone }, line: { color: tone, width: 0 } });
      s.addImage({ data: ICON[`${ic}:white`], x: x + 0.40, y: 1.90, w: 0.32, h: 0.32 });
      s.addText(head, { x: x + 0.25, y: 2.5, w: 2.4, h: 0.5, fontFace: F, fontSize: 14.5, bold: true, color: INK, isTextBox: true, margin: 0 });
      s.addText(body, { x: x + 0.25, y: 3.05, w: 2.4, h: 1.7, fontFace: F, fontSize: 10.5, color: "33465F", isTextBox: true, margin: 0, valign: "top" });
    });
    footer(s, 2);
    notes(s, "【0:30–1:20】痛点。核心一句：过去投研的瓶颈是「产生想法」，现在 AI 把这一步的成本打到零，瓶颈转移到了「可信的验证」和「上线后的持续监控」。三个断点：验证慢、过拟合、没人盯。\n落点：谁能把「AI 生成 → 严格验证 → 持续监控」做成一条自动化流水线，谁就掌握了 AI 时代投研的关键环节。");
  }

  // ================================================================ 3 solution: input → process → output
  {
    const s = pres.addSlide(); dark(s);
    title(s, "我们的答案：真实跑通的「输入 → 处理 → 输出」", "AIQUANT TERMINAL 已上线，今天现场演示的就是这条流程", true);
    const steps = [
      ["FiSearch", CYAN_L, "输入", "一句投资假设或一个市场\n（美股 118 只 / 加密 40 币 / 小时级）", "「成交量放大后的突破会延续吗？」"],
      ["FiRefreshCw", VIOLET, "处理", "Claude 提出因子表达式 → 确定性评估器打分 → 指令式反馈进入下一轮；遗传进化引擎并行搜索", "5 轮 · 数十条候选 · 全程样本外留出"],
      ["FiShield", AMBER, "检验", "五项评级 + 多重检验门槛 + 可交易门禁（换手、成本后价差）", "只有 A/B 级且扣成本为正才放行"],
      ["FiTarget", GREEN, "输出", "多因子组合 → 目标持仓 → 交易单；模拟持仓从上线日起样本外跟踪，每日监控推送", "可直接执行，也可一键上架销售"],
    ];
    steps.forEach(([ic, tone, head, body, ex], i) => {
      const x = 0.5 + i * 2.3, w = 2.15;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.6, w, h: 3.25, fill: { color: PANEL }, line: { color: "22335A", width: 0.75 }, rectRadius: 0.12 });
      circ(s, ic, "ink", x + 0.2, 1.8, 0.56, tone);
      s.addText(head, { x: x + 0.86, y: 1.8, w: w - 1.0, h: 0.56, fontFace: F, fontSize: 17, bold: true, color: WHITE, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(body, { x: x + 0.2, y: 2.5, w: w - 0.4, h: 1.5, fontFace: F, fontSize: 10.5, color: MIST, isTextBox: true, margin: 0, valign: "top" });
      s.addText(ex, { x: x + 0.2, y: 4.05, w: w - 0.4, h: 0.7, fontFace: F, fontSize: 9.5, italic: true, color: tone, isTextBox: true, margin: 0, valign: "top" });
      if (i < 3) s.addText("→", { x: x + w - 0.04, y: 2.9, w: 0.26, h: 0.5, fontFace: F, fontSize: 16, bold: true, color: AMBER, isTextBox: true, margin: 0, align: "center" });
    });
    footer(s, 3, true);
    notes(s, "【1:20–2:00】解决方案总览。强调这不是概念图，而是网站上真实存在的四个环节，等一下现场就演示：输入一句假设，几分钟后拿到一个带评级的因子和可执行的目标持仓。\n关键词：闭环（Loop Engineering）、样本外、可交易、可销售。");
  }

  // ================================================================ 4 product overview
  {
    const s = pres.addSlide(); light(s);
    title(s, "产品全景：一个网站装下从行情到交易单的全部环节", "Bloomberg 式终端体验，面向个人研究者与小型团队的价格");
    frame(s, SH.terminal, 0.5, 1.5, 5.0, "线上终端首页：跑马灯行情、K 线与指标、自选与预警、AI 分析面板");
    const mods = [
      ["FiBarChart2", CYAN, "行情终端与回测", "美股 / 加密双终端，实时行情，下一根开盘成交、双边成本、始终对照买入持有的诚实回测，含止损 / 止盈 / 波动目标等风控"],
      ["FiCpu", VIOLET, "AI 因子挖掘 + Kronos 预测", "LLM 闭环挖掘与遗传进化两台引擎；开源 K 线基础模型 Kronos 做多步预测并公开滚动准确率"],
      ["FiLayers", AMBER, "端到端量化流水线", "宇宙 → 信号 → 组合优化 → 风险 → 目标持仓 → 交易单，CPCV 与去除多重检验偏差的 Sharpe"],
      ["FiShoppingBag", GREEN, "交易市场与钱包", "策略 / 因子上架买卖，Stripe 与加密货币支付，服务器签发权益凭证，退款争议与审计日志"],
    ];
    mods.forEach(([ic, tone, head, body], i) => {
      const y = 1.45 + i * 0.93;
      circ(s, ic, "white", 5.85, y + 0.08, 0.5, tone);
      s.addText(head, { x: 6.5, y, w: 3.0, h: 0.32, fontFace: F, fontSize: 12.5, bold: true, color: INK, isTextBox: true, margin: 0 });
      s.addText(body, { x: 6.5, y: y + 0.31, w: 3.0, h: 0.62, fontFace: F, fontSize: 9.5, color: "33465F", isTextBox: true, margin: 0, valign: "top" });
    });
    footer(s, 4);
    notes(s, "【2:00–2:35】产品全景。左边是真实首页截图。四个模块一句话带过，重点放在「全部接在同一套数据与引擎上」：市场里买的策略一键进回测，因子库里的因子一键进流水线，流水线的结果一键部署成模拟持仓。这种「一体化」是我们与单点工具的差别。");
  }

  // ================================================================ 5 core tech 1: loop engineering
  {
    const s = pres.addSlide(); dark(s);
    title(s, "核心技术 ①  Loop Engineering：让 AI 在规则里迭代", "LLM 提出 → 确定性评估 → 指令式反馈 → 跨会话记忆，两台引擎互为验证", true);
    const loop = [["FiCpu", VIOLET, "提出", "Claude 在安全 DSL 内写因子表达式（自研解析器，永不 eval）"], ["FiActivity", CYAN_L, "评估", "确定性评估器：秩 IC、ICIR、留出集、换手、成本后价差、t 统计量"], ["FiRepeat", AMBER, "反馈", "把「为什么被拒」写成指令送回下一轮：别重复、别相似、换方向"], ["FiDatabase", GREEN, "记忆", "因子库与错题本跨会话带入，重复与近似候选直接跳过"]];
    const cx = 1.85, cy = 3.25, r = 1.0;
    s.addShape(pres.shapes.OVAL, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { type: "none" }, line: { color: "2A3F6A", width: 1.5, dashType: "dash" } });
    s.addText("Loop", { x: cx - 0.5, y: cy - 0.25, w: 1.0, h: 0.5, fontFace: F, fontSize: 15, bold: true, color: "3A5280", isTextBox: true, margin: 0, align: "center", valign: "middle" });
    const pos = [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];
    loop.forEach(([ic, tone, head], i) => {
      const [px, py] = pos[i];
      circ(s, ic, "ink", px - 0.28, py - 0.28, 0.56, tone);
      const lab = i === 2 ? [px - 0.6, py + 0.32, 1.2, "center"] : [px - 0.6, py - 0.68, 1.2, "center"];
      s.addText(head, { x: lab[0], y: lab[1], w: lab[2], h: 0.34, fontFace: F, fontSize: 12.5, bold: true, color: tone, isTextBox: true, margin: 0, align: lab[3], valign: "middle" });
    });
    loop.forEach(([ic, tone, head, body], i) => {
      const y = 1.55 + i * 0.85;
      s.addText(head, { x: 3.4, y, w: 1.8, h: 0.28, fontFace: F, fontSize: 11.5, bold: true, color: tone, isTextBox: true, margin: 0 });
      s.addText(body, { x: 3.4, y: y + 0.28, w: 1.8, h: 0.55, fontFace: F, fontSize: 8.5, color: MIST, isTextBox: true, margin: 0, valign: "top" });
    });
    // right: screenshot + GP note
    frame(s, SH.mining, 5.4, 1.55, 4.1, "挖掘表单：市场、持有期、成本假设、严格模式；右侧为实时循环日志", true);
    const gy = 1.55 + 4.1 / SH.mining.aspect + 0.5;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 5.4, y: gy, w: 4.1, h: 5.0 - gy, fill: { color: PANEL }, line: { color: "22335A", width: 0.75 }, rectRadius: 0.1 });
    circ(s, "FiGitBranch", "ink", 5.55, gy + 0.15, 0.44, AMBER);
    s.addText("第二台引擎：遗传进化（GP）", { x: 6.1, y: gy + 0.15, w: 3.3, h: 0.44, fontFace: F, fontSize: 12, bold: true, color: WHITE, isTextBox: true, margin: 0, valign: "middle" });
    s.addText("不依赖 LLM 的符号回归搜索，适应度同样扣除成本与换手；两台引擎找到相同方向的因子时，可信度倍增。小时级加密市场（40 币 × 1h）已支持。", { x: 5.55, y: gy + 0.66, w: 3.8, h: 5.0 - gy - 0.75, fontFace: F, fontSize: 9.5, color: MIST, isTextBox: true, margin: 0, valign: "top" });
    footer(s, 5, true);
    notes(s, "【2:35–3:15】技术一。「Loop Engineering」是我们的方法论名词：AI 不是一次性生成，而是在确定性的评估器和规则约束下反复迭代，每一轮拒绝的理由都会变成下一轮的指令。这与 Chain-of-Alpha 等论文思路一致，但我们把它做成了产品，并加了第二台不依赖 LLM 的遗传进化引擎做交叉验证。");
  }

  // ================================================================ 6 core tech 2: gates
  {
    const s = pres.addSlide(); light(s);
    title(s, "核心技术 ②  五道门禁：区分「回测漂亮」与「能赚钱」", "每一条因子都要拿到一张报告卡；不过门，就不能进组合、不能上架");
    const gates = [["FiTrendingUp", CYAN, "预测力", "分位收益单调性、IC 衰减曲线、最佳持有期"], ["FiActivity", VIOLET, "稳定性", "4 折滚动 IC、分期有效性热图、牛熊分市场"], ["FiShield", GREEN, "稳健性", "严格模式：≥3/4 折 + 两种市场状态同向"], ["FiDollarSign", AMBER, "可交易", "Top-N 换手、扣 10–15 bp 成本后的多空价差为正"], ["FiCheckCircle", RED, "显著性", "多重检验修正：|t| 门槛随累计试验次数上升（2.0→3.0）"]];
    gates.forEach(([ic, tone, head, body], i) => {
      const y = 1.45 + i * 0.62;
      circ(s, ic, "white", 0.5, y + 0.04, 0.5, tone);
      s.addText(head, { x: 1.15, y, w: 1.1, h: 0.58, fontFace: F, fontSize: 13, bold: true, color: INK, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(body, { x: 2.25, y, w: 3.3, h: 0.58, fontFace: F, fontSize: 9.5, color: "33465F", isTextBox: true, margin: 0, valign: "middle" });
    });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.5, y: 4.6, w: 5.05, h: 0.55, fill: { color: "FFF7E3" }, line: { color: "F3E2B3", width: 0.75 }, rectRadius: 0.08 });
    s.addText([{ text: "对投资人的意义：", options: { bold: true, color: INK } }, { text: "「AI 一键生成因子」把筛选责任丢给用户；我们把筛选做成产品核心，并公开上线后成绩。信任是这个市场的稀缺品。", options: { color: "33465F" } }], { x: 0.65, y: 4.63, w: 4.8, h: 0.5, fontFace: F, fontSize: 9, isTextBox: true, margin: 0, valign: "middle" });
    frame(s, SH.report, 6.0, 1.45, 3.4, "因子报告卡（真实页面）：五项评级与改进建议");
    footer(s, 6);
    notes(s, "【3:15–4:00】技术二。这一页是我们与竞品最大的区别：AI 生成因子已经不稀缺，稀缺的是把过拟合、不可交易、随机撞中的因子拦下来。五道门禁 + 报告卡 + 上线后成绩，构成了我们的「信任层」。举例：一个回测 IC 很高但 Top-5 每天换 60% 仓位的因子，扣成本就是负的——门禁直接拦下，并把理由反馈给 AI 下一轮避免。");
  }

  // ================================================================ 7 end to end: pipeline + paper + monitor
  {
    const s = pres.addSlide(); dark(s);
    title(s, "从因子到交易单，再到上线后的每一天", "端到端流水线 · 模拟持仓样本外跟踪 · 每日自动监控与推送", true);
    frame(s, SH.portfolio, 0.5, 1.5, 2.2, "流水线：目标持仓与调仓单", true);
    frame(s, SH.paper, 2.9, 1.5, 2.2, "模拟持仓：上线日起样本外回放", true);
    [["5 类", "每日告警：回撤、衰减、需调仓、数据陈旧、重算失败"], ["3 个", "推送渠道：Slack · Discord · Telegram"], ["每日", "服务器自动重检所有上架与已同步因子"]].forEach(([big, lab], i) => {
      const x = 0.5 + i * 1.57;
      s.addText(big, { x, y: 3.85, w: 1.45, h: 0.5, fontFace: F, fontSize: 22, bold: true, color: AMBER, isTextBox: true, margin: 0, valign: "bottom" });
      s.addText(lab, { x, y: 4.37, w: 1.45, h: 0.7, fontFace: F, fontSize: 8.5, color: MIST, isTextBox: true, margin: 0, valign: "top" });
    });
    const rows = [["FiLayers", AMBER, "端到端流水线", "宇宙 → 多因子信号（扩展窗口 IC 权重，每一天都是样本外）→ 均值方差 + 换手惩罚 → 风险 → 目标持仓 → 交易单；CPCV 6 组交叉验证与多重检验校正后的 Sharpe。"], ["FiClock", CYAN_L, "模拟持仓与监控", "任何策略 / 因子按真实日期部署，NAV 从那天起回放；每个交易日收盘后服务器重算，回撤超限、边际衰减、需调仓、数据陈旧五类告警推送到 Slack / Discord / Telegram。"], ["FiServer", GREEN, "运维闭环", "每日自动预热行情面板、重检所有上架与已同步因子、跑监控；数据源三重冗余（Binance / Yahoo / CoinGecko / Stooq）与健康看板。"]];
    rows.forEach(([ic, tone, head, body], i) => {
      const y = 1.5 + i * 1.2;
      circ(s, ic, "ink", 5.45, y + 0.02, 0.5, tone);
      s.addText(head, { x: 6.1, y, w: 3.4, h: 0.34, fontFace: F, fontSize: 13, bold: true, color: WHITE, isTextBox: true, margin: 0 });
      s.addText(body, { x: 6.1, y: y + 0.34, w: 3.4, h: 0.85, fontFace: F, fontSize: 9.5, color: MIST, isTextBox: true, margin: 0, valign: "top" });
    });
    footer(s, 7, true);
    notes(s, "【4:00–4:30】闭环的后半段。研究成果不停留在报告：流水线给出目标持仓和交易单；模拟持仓从部署那天起样本外记录；服务器每天替用户复检并推送告警。对投资人的含义：用户留存来自「每天都要回来看」，而不是一次性工具。");
  }

  // ================================================================ 8 live demo flow
  {
    const s = pres.addSlide(); light(s);
    title(s, "现场演示：3 分钟走完一次真实的「输入 → 处理 → 输出」", "全部在线上环境完成，无预录视频");
    const steps = [["1", "输入", "打开因子挖掘，选择美股 / 10 日持有期，输入假设：\n「成交量放大后的价格突破会延续」", "≈ 30 秒", CYAN],
      ["2", "处理", "启动闭环：观看 AI 提出表达式、评估器打分、被拒理由反馈；同时演示遗传进化的进度条", "≈ 90 秒", VIOLET],
      ["3", "输出", "点开报告卡看五项评级 → 把通过门禁的因子「→ Pipeline」生成目标持仓与交易单 → 一键部署为模拟持仓 / 上架到市场", "≈ 60 秒", GREEN]];
    steps.forEach(([n, head, body, tm, tone], i) => {
      const y = 1.5 + i * 1.12;
      s.addShape(pres.shapes.OVAL, { x: 0.5, y: y + 0.08, w: 0.72, h: 0.72, fill: { color: tone }, line: { color: tone, width: 0 } });
      s.addText(n, { x: 0.5, y: y + 0.08, w: 0.72, h: 0.72, fontFace: F, fontSize: 24, bold: true, color: WHITE, isTextBox: true, margin: 0, align: "center", valign: "middle" });
      s.addText(head, { x: 1.4, y, w: 1.2, h: 0.4, fontFace: F, fontSize: 15, bold: true, color: INK, isTextBox: true, margin: 0 });
      s.addText(tm, { x: 1.4, y: y + 0.42, w: 1.2, h: 0.3, fontFace: F, fontSize: 10, italic: true, color: tone, isTextBox: true, margin: 0 });
      s.addText(body, { x: 2.6, y, w: 2.75, h: 0.98, fontFace: F, fontSize: 10.5, color: "33465F", isTextBox: true, margin: 0, valign: "top" });
    });
    frame(s, SH.library, 5.6, 1.5, 3.9, "因子库：体检徽标、家族标签、→ Pipeline 与上架按钮");
    const ly = 1.5 + 3.9 / SH.library.aspect + 0.5;
    frame(s, SH.gp, 5.6, ly, 3.9, "遗传进化引擎实时进度");
    footer(s, 8);
    notes(s, "【4:30–7:15，其中本页讲解 15 秒、现场演示 2 分 30 秒】演示是整场唯一不可压缩的部分，也是评委给票的关键。\n演示前准备：提前在浏览器打开线上站点并登录；提前跑过一次同样的假设以便缓存命中、加载更快；因子库里预先保留 2–3 条已通过门禁的因子，保证第 3 步一定有可展示的输出。");
  }

  // ================================================================ 9 business model
  {
    const s = pres.addSlide(); dark(s);
    title(s, "商业模式：研究工具免费获客，交易与信任层变现", "三层收入 + 一个越用越强的飞轮", true);
    const tiers = [["FiShoppingBag", AMBER, "① 市场分成（已上线）", "研究者把策略 / 因子上架，买家用银行卡、Apple Pay 或加密货币购买；平台收取 10% 手续费，服务器签发权益凭证，退款争议与审计日志保障双方。"], ["FiKey", CYAN_L, "② Pro 订阅（2026 Q4）", "更高的 AI 挖掘额度、小时级市场、严格模式与多重检验报告、云端同步与每日监控推送；面向认真做研究的个人与小团队。"], ["FiBriefcase", VIOLET, "③ 机构 API / 白标（2027）", "把「挖掘 → 门禁 → 流水线」以 API 或私有部署提供给券商投顾、FOF 与金融教育机构，按席位与调用量计费。"]];
    tiers.forEach(([ic, tone, head, body], i) => {
      const y = 1.5 + i * 1.12;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.5, y, w: 4.9, h: 1.0, fill: { color: PANEL }, line: { color: "22335A", width: 0.75 }, rectRadius: 0.1 });
      circ(s, ic, "ink", 0.68, y + 0.22, 0.56, tone);
      s.addText(head, { x: 1.4, y: y + 0.1, w: 3.9, h: 0.32, fontFace: F, fontSize: 12.5, bold: true, color: WHITE, isTextBox: true, margin: 0 });
      s.addText(body, { x: 1.4, y: y + 0.42, w: 3.9, h: 0.55, fontFace: F, fontSize: 8.5, color: MIST, isTextBox: true, margin: 0, valign: "top" });
    });
    // flywheel
    const cx = 7.7, cy = 3.2, r = 0.95;
    s.addShape(pres.shapes.OVAL, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { type: "none" }, line: { color: AMBER, width: 1.5, dashType: "dash" } });
    s.addText("飞轮", { x: cx - 0.6, y: cy - 0.25, w: 1.2, h: 0.5, fontFace: F, fontSize: 16, bold: true, color: AMBER, isTextBox: true, margin: 0, align: "center", valign: "middle" });
    const fw = [["更多挖掘", cx - 1.1, cy - r - 0.55, 2.2, "center"], ["更多通过门禁\n的因子上架", cx + r + 0.05, cy - 0.3, 0.8, "left"], ["更多买家与收入", cx - 1.1, cy + r + 0.08, 2.2, "center"], ["更好的记忆\n与评估数据", cx - r - 0.95, cy - 0.3, 0.9, "right"]];
    fw.forEach(([t, x, y, w, al]) => s.addText(t, { x, y: y - 0.1, w, h: 0.8, fontFace: F, fontSize: 9.5, color: WHITE, isTextBox: true, margin: 0, align: al, valign: "middle" }));
    footer(s, 9, true);
    notes(s, "【7:15–7:55】商业模式。第一层已经在线上跑通（演示模式下可完整走完购买流程；接入真实支付通道只是配置密钥）。第二层订阅是近期重点；第三层机构 API 是中期方向。飞轮：越多人挖掘，评估器与记忆越强，越多高质量因子进入市场，越多买家——研究工具本身就是获客漏斗。\n注意：不要提供具体收入预测数字，被问到时用「首年目标：上架研究者 500 人、付费转化 5%」这类目标口径回答。");
  }

  // ================================================================ 10 market
  {
    const s = pres.addSlide(); light(s);
    title(s, "市场：被专业终端定价拒之门外的一整代研究者", "AI 投研的用户不再只是机构");
    stat(s, 0.5, 1.5, 2.9, "2.2 亿+", "中国 A 股个人投资者账户数\n（中登公司 2023 年公开数据）", CYAN, false);
    stat(s, 3.55, 1.5, 2.9, "5 亿+", "全球加密货币持有者\n（行业公开估算，2023）", VIOLET, false);
    stat(s, 6.6, 1.5, 2.9, "$2.5 万/年", "Bloomberg 级终端单席位价格\n我们的定价目标：它的 1%", AMBER, false);
    const seg = [["FiUsers", CYAN, "独立交易员与量化爱好者", "有想法、缺验证工具；愿为「确定性」付费"], ["FiBriefcase", VIOLET, "小型私募、FOF 与投顾", "需要可审计的研究流程与上线后监控，买不起也用不满整套机构系统"], ["FiBookOpen", AMBER, "金融教育与高校", "课堂即产品：本站已用于「因子挖掘」15 分钟教学演示，自带课堂演示模式"]];
    seg.forEach(([ic, tone, head, body], i) => {
      const x = 0.5 + i * 3.1;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 3.05, w: 2.9, h: 1.85, fill: { color: CARD }, line: { color: "E1E9F2", width: 0.75 }, rectRadius: 0.12 });
      circ(s, ic, "white", x + 0.2, 3.25, 0.5, tone);
      s.addText(head, { x: x + 0.85, y: 3.25, w: 1.95, h: 0.5, fontFace: F, fontSize: 11.5, bold: true, color: INK, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(body, { x: x + 0.2, y: 3.9, w: 2.5, h: 0.9, fontFace: F, fontSize: 10, color: "33465F", isTextBox: true, margin: 0, valign: "top" });
    });
    footer(s, 10);
    notes(s, "【7:55–8:25】市场。三组数字都是公开口径（路演前请再核对最新数值）：中登公司 2023 年 A 股投资者数突破 2.2 亿；全球加密持有者 5 亿以上为行业机构估算；Bloomberg 终端约 2.5 万美元/年/席位。我们的判断：AI 让研究能力民主化，但专业级的验证与监控工具仍是空白，这就是我们的位置。");
  }

  // ================================================================ 11 moat
  {
    const s = pres.addSlide(); dark(s);
    title(s, "为什么是我们：方法论、信任层与工程质量三重壁垒", "别人可以复制一个「AI 生成因子」的按钮，很难复制一整条经得起审计的流水线", true);
    const moats = [["FiShield", AMBER, "验证方法论", "留出集、CPCV、多重检验校正（Deflated Sharpe）、可交易门禁、因子家族去重与边际贡献——每一项都有论文依据并落地为产品功能，而非白皮书。"], ["FiLock", CYAN_L, "信任层", "服务器签发的 HMAC 权益凭证、退款与争议流程、只追加的审计日志、上架因子每日重检的公开成绩、分级管理令牌——一个「敢让别人在上面花钱」的市场。"], ["FiDatabase", VIOLET, "数据与运维", "行情源三重冗余与健康看板、每日自动运维、真实数据夜测、Vercel 无服务器 + 边缘 KV，零运维人力即可全球服务。"], ["FiCheckCircle", GREEN, "工程质量", "后端 283 个自动化测试、28 条端到端浏览器测试、前后端 API 契约测试、代码规范全部进入 CI；每次提交自动部署。"]];
    moats.forEach(([ic, tone, head, body], i) => {
      const col = i % 2, row = Math.floor(i / 2), x = 0.5 + col * 4.6, y = 1.5 + row * 1.75;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 4.4, h: 1.6, fill: { color: PANEL }, line: { color: "22335A", width: 0.75 }, rectRadius: 0.12 });
      circ(s, ic, "ink", x + 0.2, y + 0.2, 0.52, tone);
      s.addText(head, { x: x + 0.9, y: y + 0.2, w: 3.3, h: 0.52, fontFace: F, fontSize: 14, bold: true, color: WHITE, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(body, { x: x + 0.2, y: y + 0.8, w: 4.0, h: 0.75, fontFace: F, fontSize: 9.5, color: MIST, isTextBox: true, margin: 0, valign: "top" });
    });
    footer(s, 11, true);
    notes(s, "【8:25–8:55】壁垒。投资人会问「大模型公司或券商为什么不做」：大模型公司不做垂直的验证与交易闭环；券商受合规与组织约束不做开放市场。我们的护城河在于把学术界成熟的方法论产品化，并在市场层建立了信任机制——这两者叠加需要时间和真实运行数据。工程质量数字是真实的 CI 数据。");
  }

  // ================================================================ 12 traction + roadmap
  {
    const s = pres.addSlide(); light(s);
    title(s, "进展与里程碑：产品已上线，下一步是把流量变成收入", "所有功能均在线可用");
    stat(s, 0.5, 1.4, 2.2, "12", "核心模块全部上线", CYAN, false);
    stat(s, 2.8, 1.4, 2.2, "158", "标的宇宙：118 美股 + 40 加密币\n含小时级市场", VIOLET, false);
    stat(s, 5.1, 1.4, 2.2, "80+", "公开 API 端点，前后端契约测试守护", AMBER, false);
    stat(s, 7.4, 1.4, 2.2, "311", "自动化测试（后端 283 + 端到端 28）", GREEN, false);
    // timeline
    const tl = [["2026 Q3", "已完成", "终端、回测、Kronos、因子挖掘双引擎、流水线 V4、市场与钱包、账户与监控、后台运维全部上线", GREEN],
      ["2026 Q4", "商业化启动", "开通真实支付与首批 50 名上架研究者；Pro 订阅上线；A 股行情与因子宇宙接入", CYAN],
      ["2027 H1", "规模化", "移动端与推送；社区因子排行榜与跟投；与 1–2 家券商 / 教育机构试点 API", VIOLET],
      ["2027 H2", "机构化", "私有化部署版本；合规咨询与实盘接口伙伴；探索海外市场", AMBER]];
    s.addShape(pres.shapes.LINE, { x: 0.9, y: 3.55, w: 8.2, h: 0, line: { color: "C5D3E3", width: 1.5 } });
    tl.forEach(([q, head, body, tone], i) => {
      const x = 0.5 + i * 2.3;
      s.addShape(pres.shapes.OVAL, { x: x + 0.95, y: 3.45, w: 0.2, h: 0.2, fill: { color: tone }, line: { color: WHITE, width: 1.5 } });
      s.addText(q, { x, y: 3.0, w: 2.1, h: 0.35, fontFace: F, fontSize: 12, bold: true, color: tone, isTextBox: true, margin: 0, align: "center" });
      s.addText(head, { x, y: 3.75, w: 2.1, h: 0.3, fontFace: F, fontSize: 11.5, bold: true, color: INK, isTextBox: true, margin: 0, align: "center" });
      s.addText(body, { x, y: 4.07, w: 2.1, h: 1.0, fontFace: F, fontSize: 9, color: "33465F", isTextBox: true, margin: 0, align: "center", valign: "top" });
    });
    footer(s, 12);
    notes(s, "【8:55–9:20】进展。四个数字都是真实的：12 个模块、118+40 标的宇宙、80 多个 API 端点、311 个自动化测试。路线图重点讲 Q4：开通真实支付与首批上架研究者，是从「产品」到「生意」的转折点。");
  }

  // ================================================================ 13 ask
  {
    const s = pres.addSlide(); dark(s);
    title(s, "融资需求：天使轮 300 万元，18 个月做成研究市场", "资金用途与阶段目标", true);
    const use = [["研发与数据", 45, CYAN_L, "A 股与多市场行情、小时级与更多资产、移动端；AI 调用与算力"], ["市场与社区", 30, AMBER, "研究者招募与激励、高校与券商合作、内容与课程"], ["合规与运营", 15, VIOLET, "支付与资金合规、法律意见、审计"], ["储备", 10, GREEN, "12 个月安全垫"]];
    s.addChart(pres.charts.DOUGHNUT, [{ name: "用途", labels: use.map((u) => u[0]), values: use.map((u) => u[1]) }], {
      x: 0.4, y: 1.35, w: 3.6, h: 3.6, holeSize: 55, chartColors: use.map((u) => u[2]), showLegend: false, showPercent: true, showValue: false,
      dataLabelColor: WHITE, dataLabelFontSize: 10, dataLabelFontFace: F, showTitle: false, dataBorder: { pt: 1, color: NAVY },
    });
    use.forEach(([n, p, c, d], i) => {
      const y = 1.5 + i * 0.78;
      s.addShape(pres.shapes.OVAL, { x: 4.2, y: y + 0.08, w: 0.18, h: 0.18, fill: { color: c }, line: { color: c, width: 0 } });
      s.addText(`${n} · ${p}%`, { x: 4.5, y, w: 2.2, h: 0.3, fontFace: F, fontSize: 12, bold: true, color: WHITE, isTextBox: true, margin: 0 });
      s.addText(d, { x: 4.5, y: y + 0.3, w: 2.3, h: 0.45, fontFace: F, fontSize: 8.5, color: MIST, isTextBox: true, margin: 0, valign: "top" });
    });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 7.0, y: 1.45, w: 2.5, h: 3.5, fill: { color: PANEL }, line: { color: "22335A", width: 0.75 }, rectRadius: 0.12 });
    s.addText("18 个月目标", { x: 7.2, y: 1.6, w: 2.1, h: 0.4, fontFace: F, fontSize: 14, bold: true, color: AMBER, isTextBox: true, margin: 0 });
    s.addText(bullets(["注册研究者 1 万，付费订阅转化 5%", "上架策略 / 因子 1,000 条，月交易额 50 万元", "2 家机构 API 试点客户", "A 股 + 美股 + 加密三市场全覆盖", "启动 Pre-A 轮"], 10.5, WHITE), { x: 7.2, y: 2.05, w: 2.15, h: 2.8, isTextBox: true, margin: 0, valign: "top" });
    footer(s, 13, true);
    notes(s, "【9:20–9:45】融资需求。金额与比例是建议方案，路演前请按自身实际调整（导师会追问估值与出让比例，建议准备：天使轮出让 10–15%）。用途重点：研发与数据占大头，因为 A 股接入与移动端是下一阶段增长引擎；合规预算显示我们对支付与资金托管的重视。18 个月目标全部是可验证的经营指标。");
  }

  // ================================================================ 14 close
  {
    const s = pres.addSlide(); dark(s);
    s.addImage({ data: ICON["FiCpu:light"], x: 0.6, y: 0.8, w: 0.7, h: 0.7 });
    s.addText("AI 时代的投研，瓶颈不在想法，而在可信的验证。", { x: 0.6, y: 1.6, w: 5.6, h: 1.1, fontFace: F, fontSize: 24, bold: true, color: WHITE, isTextBox: true, margin: 0 });
    s.addText("AIQUANT TERMINAL 把「AI 提出 → 严格检验 → 交易执行 → 持续监控 → 市场交易」做成了一条已经在线运行的流水线。我们邀请您一起，把它做成 AI 投研时代的基础设施。", { x: 0.6, y: 2.8, w: 5.4, h: 1.2, fontFace: F, fontSize: 12.5, color: MIST, isTextBox: true, margin: 0 });
    const links = [["FiGlobe", "aiquant-rust.vercel.app", "线上产品，现在就能试"], ["FiGitBranch", "github.com/presleyzhou/Aiquant", "开源仓库与完整文档"], ["FiMail", "Presley Zhou · presley.zhou@cailif.ca", "路演后欢迎联系深聊"]];
    links.forEach(([ic, t, d], i) => {
      const y = 4.05 + i * 0.45;
      s.addImage({ data: ICON[`${ic}:amber`], x: 0.6, y: y + 0.05, w: 0.26, h: 0.26 });
      s.addText(t, { x: 1.0, y, w: 3.2, h: 0.36, fontFace: F, fontSize: 11, bold: true, color: WHITE, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(d, { x: 4.1, y, w: 2.2, h: 0.36, fontFace: F, fontSize: 9.5, color: GREY, isTextBox: true, margin: 0, valign: "middle" });
    });
    frame(s, SH.market, 6.3, 1.2, 3.3, "交易市场：策略与因子在这里被买卖", true);
    s.addText("谢谢 · 欢迎提问", { x: 6.3, y: 4.6, w: 3.3, h: 0.5, fontFace: F, fontSize: 18, bold: true, color: AMBER, isTextBox: true, margin: 0, align: "right" });
    footer(s, 14, true);
    notes(s, "【9:45–10:00】收尾。回到开头那句话，然后明确给出「邀请」。留 10 秒给评委记网址。随后进入 10 分钟导师互动——常见问题的答法见讲稿附录。");
  }

  // ================================================================ appendix A: methodology
  {
    const s = pres.addSlide(); light(s);
    title(s, "附录 A · 验证方法论速查（供问答）", "每一项都对应产品中一个可点击的功能");
    const rows = [["留出集与样本外", "挖掘只看训练段；留出段 IC 单独汇报；模拟持仓从部署日起一切样本外"], ["CPCV 组合式净化交叉验证", "6 组、k=2 → 5 条拼接的样本外路径，含净化与禁运期；给出路径 Sharpe 分布"], ["多重检验校正", "显著性门槛随累计试验次数上升（|t| ≥ 2.0，每十倍 +0.5，上限 3.0）；流水线报告 Deflated Sharpe"], ["可交易门禁", "Top-N 换手率、扣 10 / 15 bp 双边成本后的分位多空价差；负值直接拒绝并反馈给 AI"], ["稳健性（严格模式）", "4 折滚动 IC 至少 3 折同向 + 牛熊两种市场状态同向；分期有效性热图可视化"], ["因子家族与边际贡献", "|相关| ≥ 0.5 单链接聚类，按家族等权合成；Δ Sharpe 报告加入 / 移除某因子的组合变化"], ["回测诚实性", "下一根开盘成交、双边佣金与滑点、始终对照买入持有；止损 / 止盈 / 移动止损 / 波动目标按上一根收盘判定"], ["上线后成绩", "服务器每日重检上架与已同步因子：近 60 根方向对齐 IC、五项评级、衰减标记，卖家不可修改"]];
    rows.forEach(([k, v], i) => {
      const y = 1.45 + i * 0.46;
      s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y, w: 9.0, h: 0.42, fill: { color: i % 2 ? WHITE : CARD }, line: { color: i % 2 ? WHITE : CARD, width: 0 } });
      s.addText(k, { x: 0.6, y, w: 2.6, h: 0.42, fontFace: F, fontSize: 10.5, bold: true, color: INK, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(v, { x: 3.25, y, w: 6.2, h: 0.42, fontFace: F, fontSize: 9.5, color: "33465F", isTextBox: true, margin: 0, valign: "middle" });
    });
    s.addText("附录", { x: 0.5, y: 5.25, w: 9, h: 0.25, fontFace: F, fontSize: 8.5, color: GREY, isTextBox: true, margin: 0, align: "right" });
    notes(s, "问答备用。若导师质疑「AI 挖因子就是数据挖掘、必然过拟合」，逐条指向这张表：我们不是否认过拟合，而是把学术界对抗过拟合的全部工具做成了默认开启的产品功能。");
  }

  // ================================================================ appendix B: architecture
  {
    const s = pres.addSlide(); dark(s);
    title(s, "附录 B · 技术架构与安全（供问答）", "无服务器架构，零运维人力即可全球服务", true);
    const layers = [["FiGlobe", CYAN_L, "前端", "React + Vite，按视图懒加载；Playwright 端到端测试 28 条；深色终端风格，图表可访问性与键盘操作"], ["FiServer", AMBER, "后端", "FastAPI（Vercel 无服务器函数）+ Hugging Face Space 承载 Kronos 推理；80+ REST 端点 + WebSocket 行情；ruff 规范 + 283 个 pytest 进入 CI"], ["FiDatabase", VIOLET, "数据与存储", "行情：Binance / Yahoo / CoinGecko / Stooq / AkShare 多源冗余与三层缓存；业务：Upstash KV（上架、订单、钱包、争议、审计）；账户：Supabase Auth"], ["FiLock", GREEN, "安全与信任", "因子 DSL 自研解析器永不 eval；HMAC 签发权益凭证；Stripe / Coinbase webhook 签名校验；分级管理令牌；只追加审计日志；Sentry 可观测性；限流与熔断"]];
    layers.forEach(([ic, tone, head, body], i) => {
      const y = 1.5 + i * 0.9;
      circ(s, ic, "ink", 0.5, y + 0.05, 0.5, tone);
      s.addText(head, { x: 1.15, y, w: 1.4, h: 0.6, fontFace: F, fontSize: 13, bold: true, color: WHITE, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(body, { x: 2.6, y, w: 6.9, h: 0.8, fontFace: F, fontSize: 10, color: MIST, isTextBox: true, margin: 0, valign: "middle" });
    });
    s.addText("附录", { x: 0.5, y: 5.25, w: 9, h: 0.25, fontFace: F, fontSize: 8.5, color: GREY_D, isTextBox: true, margin: 0, align: "right" });
    notes(s, "问答备用。被问「团队多大、怎么维护」时的答案：整套系统按无服务器设计，每日运维、重检、监控、数据夜测均由 GitHub Actions 自动完成，一名工程师即可维持；资金用于扩展市场与数据，而非堆运维人力。");
  }

  const out = __dirname + "/AIQUANT-路演.pptx";
  await pres.writeFile({ fileName: out });
  console.log("wrote", out);
})().catch((e) => { console.error(e); process.exit(1); });
