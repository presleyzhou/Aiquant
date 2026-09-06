const pptxgen = require("pptxgenjs");
const sharp = require("sharp");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const Fi = require("react-icons/fi");

const NAVY = "0B1020", INK = "13213A", CYAN = "0FA8C9", CYAN_L = "3BE0FF", VIOLET = "7C5CFF", GREY = "6B7A90", LIGHT = "EEF6FA", WHITE = "FFFFFF", AMBER = "F0A500", GREEN = "1FA971", RED = "D9485F", MIST = "DCE7F2";
const F = "Microsoft YaHei";

async function icon(name, color, size = 256) {
  const svg = renderToStaticMarkup(React.createElement(Fi[name], { size, color: `#${color}`, strokeWidth: 1.6 }));
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}

const SHOTS = __dirname + "/shots";
/** Load a screenshot (optionally cropped to a fraction of its height/width), downscale, return {data, aspect}. */
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
  pres.title = "因子挖掘 15 分钟";
  const TOTAL = 14;

  // pre-render icons
  const names = ["FiCpu", "FiHelpCircle", "FiRefreshCw", "FiBriefcase", "FiDatabase", "FiClock", "FiBarChart2", "FiTool", "FiEdit3", "FiCheckSquare", "FiBookOpen", "FiCheck", "FiX", "FiGitBranch", "FiLock", "FiInbox", "FiTrendingUp", "FiFileText", "FiEye", "FiTarget", "FiActivity", "FiShield", "FiAlertTriangle", "FiLayers", "FiSliders", "FiAward", "FiRepeat", "FiGlobe", "FiPlayCircle"];
  const ICON = {};
  for (const n of names) { ICON[n + ":cyan"] = await icon(n, CYAN); ICON[n + ":light"] = await icon(n, CYAN_L); ICON[n + ":violet"] = await icon(n, VIOLET); ICON[n + ":white"] = await icon(n, WHITE); ICON[n + ":amber"] = await icon(n, AMBER); ICON[n + ":green"] = await icon(n, GREEN); ICON[n + ":red"] = await icon(n, RED); }

  const SH = {
    terminal: await shot("terminal.png"),
    mining: await shot("mining.png", { y1: 0.5 }),
    gp: await shot("gp-progress.png", { y1: 0.7 }),
    portfolio: await shot("portfolio.png", { y0: 0.545, y1: 0.985 }),
    report: await shot("report.png", { y1: 0.37 }),
    paper: await shot("paper.png", { y1: 0.66 }),
    library: await shot("library.png", { y1: 0.38 }),
  };

  const darkBg = (s) => {
    s.background = { color: NAVY };
    for (let i = 0; i < 14; i++) for (let j = 0; j < 8; j++)
      s.addShape(pres.shapes.OVAL, { x: 0.35 + i * 0.7, y: 0.35 + j * 0.7, w: 0.04, h: 0.04, fill: { color: "1E3352" }, line: { color: "1E3352", width: 0 } });
  };
  const title = (s, text, sub) => {
    s.addText(text, { x: 0.5, y: 0.35, w: 9, h: 0.7, fontFace: F, fontSize: 28, bold: true, color: INK, isTextBox: true, margin: 0 });
    if (sub) s.addText(sub, { x: 0.5, y: 1.0, w: 9, h: 0.4, fontFace: F, fontSize: 12.5, color: GREY, isTextBox: true, margin: 0 });
  };
  const footer = (s, n) => s.addText(`AIQUANT TERMINAL · 因子挖掘 · ${n}/${TOTAL}`, { x: 0.5, y: 5.22, w: 9, h: 0.28, fontFace: F, fontSize: 9, color: GREY, isTextBox: true, margin: 0, align: "right" });
  const circleIcon = (s, name, x, y, d = 0.6, bg = CYAN, tone = "white") => {
    s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: bg }, line: { color: bg, width: 0 } });
    s.addImage({ data: ICON[`${name}:${tone}`], x: x + d * 0.22, y: y + d * 0.22, w: d * 0.56, h: d * 0.56 });
  };
  /** Screenshot in a rounded dark frame, sized by width (height follows aspect) unless h is given (then width follows). */
  const frame = (s, sh, x, y, { w, h, caption } = {}) => {
    if (w === undefined) w = h * sh.aspect; else if (h === undefined) h = w / sh.aspect;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x - 0.06, y: y - 0.06, w: w + 0.12, h: h + 0.12, rectRadius: 0.08, fill: { color: INK }, line: { color: "2A3F5F", width: 0.75 }, shadow: { type: "outer", blur: 6, offset: 2, angle: 90, color: "000000", opacity: 0.35 } });
    s.addImage({ data: sh.data, x, y, w, h, rounding: false });
    if (caption) s.addText(caption, { x, y: y + h + 0.07, w, h: 0.3, fontFace: F, fontSize: 8.5, color: GREY, isTextBox: true, margin: 0, italic: true });
    return { w, h };
  };
  const card = (s, x, y, w, h, head, body, color = CYAN, iconName) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: LIGHT }, line: { color: "D6E4EC", width: 0.75 } });
    let tx = x + 0.2;
    if (iconName) { circleIcon(s, iconName, x + 0.18, y + 0.16, 0.5, color); tx = x + 0.8; }
    s.addText(head, { x: tx, y: y + 0.18, w: w - (tx - x) - 0.2, h: 0.42, fontFace: F, fontSize: 14, bold: true, color, isTextBox: true, margin: 0, valign: "middle" });
    s.addText(body, { x: x + 0.2, y: y + 0.7, w: w - 0.4, h: Math.max(0.3, h - 0.8), fontFace: F, fontSize: 11, color: INK, isTextBox: true, margin: 0, valign: "top" });
  };
  const cardSm = (s, x, y, w, h, head, body, color = CYAN, iconName) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: LIGHT }, line: { color: "D6E4EC", width: 0.75 } });
    let tx = x + 0.15;
    if (iconName) { circleIcon(s, iconName, x + 0.12, y + 0.1, 0.36, color); tx = x + 0.56; }
    s.addText(head, { x: tx, y: y + 0.1, w: w - (tx - x) - 0.1, h: 0.36, fontFace: F, fontSize: 12, bold: true, color, isTextBox: true, margin: 0, valign: "middle" });
    s.addText(body, { x: x + 0.15, y: y + 0.5, w: w - 0.3, h: h - 0.58, fontFace: F, fontSize: 10, color: INK, isTextBox: true, margin: 0, valign: "top" });
  };
  const code = (s, text, x, y, w, h) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.08, fill: { color: INK }, line: { color: INK, width: 0 } });
    s.addText(text, { x: x + 0.15, y: y + 0.08, w: w - 0.3, h: h - 0.16, fontFace: "Courier New", fontSize: 11, color: CYAN_L, isTextBox: true, margin: 0, valign: "middle" });
  };
  const chartFrame = { catAxisLabelColor: GREY, valAxisLabelColor: GREY, catAxisLabelFontSize: 9, valAxisLabelFontSize: 8, valGridLine: { color: "E3ECF2", size: 0.5 }, catGridLine: { style: "none" }, titleFontFace: F, titleColor: INK, titleFontSize: 10, legendFontSize: 9, legendColor: GREY };

  let s;
  // ---------------------------------------------------------------- 1 cover
  s = pres.addSlide(); darkBg(s);
  s.addImage({ data: ICON["FiCpu:light"], x: 0.6, y: 0.8, w: 0.8, h: 0.8 });
  s.addText("因子挖掘", { x: 0.6, y: 1.7, w: 4.4, h: 0.9, fontFace: F, fontSize: 42, bold: true, color: WHITE, isTextBox: true, margin: 0 });
  s.addText("让机器找信号，让规则守底线 —— 15 分钟", { x: 0.6, y: 2.6, w: 4.4, h: 0.8, fontFace: F, fontSize: 17, color: CYAN_L, isTextBox: true, margin: 0 });
  s.addText("以 AIQUANT TERMINAL 的「因子挖掘」板块为例：Loop Engineering 闭环挖掘 + 遗传进化，全程样本外验证", { x: 0.6, y: 3.5, w: 4.3, h: 0.9, fontFace: F, fontSize: 11.5, color: "AFC3DA", isTextBox: true, margin: 0 });
  frame(s, SH.terminal, 5.2, 1.05, { w: 4.4, caption: "AIQUANT TERMINAL 主界面（真实截图）" });
  s.addText("aiquant-rust.vercel.app · 因子挖掘", { x: 0.7, y: 4.75, w: 6, h: 0.3, fontFace: F, fontSize: 11, color: GREY, isTextBox: true, margin: 0 });
  s.addNotes("讲义：开讲之前。30 秒：机器很会找规律，也很会找假规律；整套方法就是放开找、用规则挡假规律。");

  // ---------------------------------------------------------------- 2 three questions
  s = pres.addSlide(); title(s, "这堂课要回答的三个问题", "接下来的每一页都在回答其中之一"); footer(s, 2);
  [["什么叫因子？", "怎么判断一个因子好不好？", "FiHelpCircle", CYAN], ["机器怎样自动找因子？", "怎样让它一轮比一轮找得更好（Loop Engineering）？", "FiRefreshCw", VIOLET], ["找到之后呢？", "怎样变成能赚钱的组合？上线后怎么知道它还灵不灵？", "FiBriefcase", GREEN]].forEach(([h, b, ic, c], i) => {
    const x = 0.5 + i * 3.1;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.6, w: 2.9, h: 3.2, rectRadius: 0.14, fill: { color: LIGHT }, line: { color: "D6E4EC", width: 0.75 } });
    circleIcon(s, ic, x + 0.95, y = 1.85, 1.0, c);
    s.addText(h, { x: x + 0.2, y: 3.0, w: 2.5, h: 0.5, fontFace: F, fontSize: 16, bold: true, color: c, isTextBox: true, margin: 0, align: "center" });
    s.addText(b, { x: x + 0.25, y: 3.55, w: 2.4, h: 1.1, fontFace: F, fontSize: 11.5, color: INK, isTextBox: true, margin: 0, align: "center" });
  });
  s.addNotes("讲义：开讲之前。念完三个问题即可，不展开。");

  // ---------------------------------------------------------------- 3 what is a factor
  s = pres.addSlide(); title(s, "什么是因子：给全班每天打一个分", "同一天把所有股票放在一起比 —— 横截面"); footer(s, 3);
  // ranking table illustration
  const rows = [["AAPL", "0.92", "1", "+3.1%", "2"], ["NVDA", "0.85", "2", "+4.0%", "1"], ["MSFT", "0.61", "3", "+1.2%", "3"], ["TSLA", "0.40", "4", "-0.5%", "5"], ["META", "0.33", "5", "+0.4%", "4"], ["AMZN", "0.12", "6", "-2.2%", "6"]];
  const hx = 0.5, hy = 1.6, cw = [1.0, 0.85, 0.6, 1.0, 0.6];
  ["股票", "因子分", "排名", "10 天后收益", "排名"].forEach((h, i) => {
    const x = hx + cw.slice(0, i).reduce((a, b) => a + b, 0);
    s.addShape(pres.shapes.RECTANGLE, { x, y: hy, w: cw[i], h: 0.36, fill: { color: INK }, line: { color: INK, width: 0 } });
    s.addText(h, { x, y: hy, w: cw[i], h: 0.36, fontFace: F, fontSize: 9.5, bold: true, color: WHITE, isTextBox: true, margin: 0, align: "center", valign: "middle" });
  });
  rows.forEach((r, ri) => r.forEach((v, i) => {
    const x = hx + cw.slice(0, i).reduce((a, b) => a + b, 0), y = hy + 0.36 + ri * 0.36;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw[i], h: 0.36, fill: { color: ri % 2 ? LIGHT : WHITE }, line: { color: "E3ECF2", width: 0.5 } });
    s.addText(v, { x, y, w: cw[i], h: 0.36, fontFace: i === 0 ? F : "Courier New", fontSize: 10, color: i === 3 ? (v.startsWith("-") ? RED : GREEN) : INK, bold: i === 2 || i === 4, isTextBox: true, margin: 0, align: "center", valign: "middle" });
  }));
  s.addText("同一天 · 60 只股票各打一分 → 排序 → 看 10 天后收益的排序是否一致", { x: 0.5, y: 4.15, w: 4.1, h: 0.5, fontFace: F, fontSize: 10.5, color: GREY, isTextBox: true, margin: 0, italic: true });
  code(s, "rank(delta(close, 20))\n= 「20 日涨幅」在全市场的排名\n  最朴素的动量因子", 4.9, 1.6, 4.6, 1.15);
  s.addText([
    { text: "因子 = 打分规则。", options: { bold: true, color: CYAN, breakLine: true } },
    { text: "分数本身不重要，重要的是排序：今天分高的那批，接下来十天是不是整体跑赢分低的那批。", options: { breakLine: true } },
    { text: " ", options: { breakLine: true } },
    { text: "不是在预测某一只股票，", options: { bold: true, breakLine: true } },
    { text: "而是在同一天把所有股票横着比。这是因子研究与普通看盘最不一样的地方。", options: {} },
  ], { x: 4.9, y: 2.95, w: 4.6, h: 2.1, fontFace: F, fontSize: 12, color: INK, isTextBox: true, margin: 0, paraSpaceAfter: 4 });
  s.addNotes("讲义 1.1。指着左表讲：两列排名越一致，规则越有用。示意数据。");

  // ---------------------------------------------------------------- 4 IC
  s = pres.addSlide(); title(s, "怎么判断因子好不好：IC", "今天的排名和十天后收益的排名有多一致，从 −1 到 1，每天算一个"); footer(s, 4);
  const icDays = Array.from({ length: 40 }, (_, i) => `${i + 1}`);
  const icVals = icDays.map((_, i) => Math.round((0.022 + 0.11 * Math.sin(i * 1.7) * Math.cos(i * 0.6) + (i % 7 === 3 ? -0.08 : 0)) * 1000) / 1000);
  s.addChart(pres.charts.LINE, [{ name: "每日 IC", labels: icDays, values: icVals }], { x: 0.5, y: 1.55, w: 5.6, h: 3.3, chartColors: [CYAN], lineSize: 1.5, lineDataSymbol: "none", showTitle: true, title: "示意：一条因子的每日 IC（40 天）——平均在 0 上方一点，且抖动", showLegend: false, valAxisMinVal: -0.15, valAxisMaxVal: 0.15, valAxisLabelFormatCode: "0.00", catAxisLabelFrequency: 5, ...chartFrame });
  card(s, 6.4, 1.55, 3.1, 1.55, "看平均值", "平均 IC 离 0 多远 = 预测力。美股日频 0.02 已可用，0.05 以上先怀疑偷看未来。", CYAN, "FiTarget");
  card(s, 6.4, 3.3, 3.1, 1.55, "看抖不抖", "ICIR = 平均值 ÷ 波动，衡量「稳定地有用」。全靠几天暴涨撑起来的因子，ICIR 很低。", VIOLET, "FiActivity");
  s.addNotes("讲义 1.2。IC 很小但每天赢一点、几十只一起下注，累积可观。数量感：0.01–0.03。");

  // ---------------------------------------------------------------- 5 blocks
  s = pres.addSlide(); title(s, "因子长什么样：一套固定的积木", "机器能生成、程序能校验、人能看懂"); footer(s, 5);
  [["原料", "开盘、最高、最低、收盘、成交量", "FiDatabase", GREEN], ["沿时间看", "过去 N 天的平均、标准差、最大最小、排名、变化量、相关性", "FiClock", CYAN], ["横着比", "排名、标准化：把不同股票放到同一尺度", "FiBarChart2", VIOLET], ["小零件", "加减乘除、绝对值、对数、开方、取符号", "FiTool", AMBER]].forEach(([h, b, ic, c], i) => card(s, 0.5 + (i % 2) * 4.6, 1.55 + Math.floor(i / 2) * 1.5, 4.4, 1.35, h, b, c, ic));
  code(s, "rank(ts_corr(close, volume, 20))   ← 「过去 20 天价量相关性」的全市场排名，抓价涨量增", 0.5, 4.6, 9.0, 0.5);
  s.addText("硬规则：长度 ≤ 240 字 · 嵌套 ≤ 10 层 · 窗口 1–120 天 · 全空值或常数直接拒绝 · 裸价格/裸成交量不算因子", { x: 0.5, y: 4.92, w: 9, h: 0.3, fontFace: F, fontSize: 9.5, color: GREY, isTextBox: true, margin: 0 });
  s.addNotes("讲义 2。为什么限制：同一搜索空间、可确定性计算、安全。");

  // ---------------------------------------------------------------- 6 grading
  s = pres.addSlide(); title(s, "怎么判卷：模拟考、高考和录取线", "样本内可以反复练，留出集只考一次"); footer(s, 6);
  s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 1.6, w: 4.4, h: 0.5, fill: { color: CYAN }, line: { color: CYAN, width: 0 } });
  s.addText("前 80% · 样本内（模拟考）", { x: 0.5, y: 1.6, w: 4.4, h: 0.5, fontFace: F, fontSize: 12, bold: true, color: WHITE, isTextBox: true, margin: 0, align: "center", valign: "middle" });
  s.addShape(pres.shapes.RECTANGLE, { x: 4.9, y: 1.6, w: 1.1, h: 0.5, fill: { color: RED }, line: { color: RED, width: 0 } });
  s.addText("后 20% 高考", { x: 4.9, y: 1.6, w: 1.1, h: 0.5, fontFace: F, fontSize: 10, bold: true, color: WHITE, isTextBox: true, margin: 0, align: "center", valign: "middle" });
  s.addImage({ data: ICON["FiLock:red"], x: 6.1, y: 1.7, w: 0.3, h: 0.3 });
  s.addText("留出集不进反馈，只考一次", { x: 6.45, y: 1.6, w: 3.1, h: 0.5, fontFace: F, fontSize: 11, color: RED, isTextBox: true, margin: 0, valign: "middle", bold: true });
  s.addChart(pres.charts.BAR, [
    { name: "样本内 IC", labels: ["候选 A", "候选 B", "候选 C", "候选 D"], values: [0.031, 0.024, 0.019, 0.022] },
    { name: "留出 IC", labels: ["候选 A", "候选 B", "候选 C", "候选 D"], values: [0.027, -0.004, 0.017, 0.006] },
  ], { x: 0.5, y: 2.3, w: 5.2, h: 2.75, barDir: "col", chartColors: [CYAN, RED], showTitle: true, title: "示意：样本内漂亮 ≠ 高考成立（B、D 被拒）", showValue: true, dataLabelPosition: "outEnd", dataLabelFontSize: 8, dataLabelFormatCode: "0.000", dataLabelColor: INK, showLegend: true, legendPos: "b", valAxisLabelFormatCode: "0.00", ...chartFrame });
  s.addTable([
    [{ text: "档位", options: { bold: true, color: WHITE, fill: { color: INK } } }, { text: "样本内 IC", options: { bold: true, color: WHITE, fill: { color: INK } } }, { text: "ICIR", options: { bold: true, color: WHITE, fill: { color: INK } } }, { text: "用途", options: { bold: true, color: WHITE, fill: { color: INK } } }],
    ["严格", "≥ 0.020", "≥ 0.25", "少而精"], ["标准", "≥ 0.015", "≥ 0.15", "默认 · 美股"], ["宽松", "≥ 0.010", "≥ 0.08", "加密：噪声大"],
  ], { x: 5.95, y: 2.3, w: 3.55, colW: [0.7, 0.95, 0.75, 1.15], fontFace: F, fontSize: 9.5, color: INK, border: { type: "solid", pt: 0.5, color: "D6E4EC" }, fill: { color: LIGHT }, rowH: 0.36, align: "center", valign: "middle" });
  s.addText("三档只放宽样本内的线；高考那关谁都不豁免：方向一致，强度 ≥ 录取线的一半。", { x: 5.95, y: 3.9, w: 3.55, h: 1.1, fontFace: F, fontSize: 10.5, color: INK, isTextBox: true, margin: 0 });
  s.addNotes("讲义 3。例子：波动率因子样本内 0.021、留出 −0.003。互动：为什么加密用宽松档。");

  // ---------------------------------------------------------------- 7 loop definition
  s = pres.addSlide(); title(s, "Loop Engineering：让机器一轮比一轮找得好", "把成绩单和错题本放回下一轮题目 —— 变的是上下文，不是模型"); footer(s, 7);
  const cx = 2.6, cy = 3.3, R = 1.25;
  const nodes = [["生成", "AI 写候选", "FiEdit3", CYAN, -90], ["评估", "程序打分", "FiCheckSquare", VIOLET, 0], ["反思", "归纳教训", "FiBookOpen", AMBER, 90], ["更新", "组装下一轮", "FiRefreshCw", GREEN, 180]];
  s.addShape(pres.shapes.OVAL, { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R, fill: { type: "none" }, line: { color: "C9D8E4", width: 1.5, dashType: "dash" } });
  nodes.forEach(([h, b, ic, c, deg]) => {
    const a = (deg * Math.PI) / 180, x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
    circleIcon(s, ic, x - 0.33, y - 0.33, 0.66, c);
    const lx = deg === 0 ? x + 0.42 : deg === 180 ? x - 1.62 : x - 0.6, ly = deg === -90 ? y - 0.95 : deg === 90 ? y + 0.4 : y - 0.3;
    s.addText([{ text: h, options: { bold: true, color: c, breakLine: true } }, { text: b, options: { color: GREY } }], { x: lx, y: ly, w: 1.2, h: 0.55, fontFace: F, fontSize: 11, isTextBox: true, margin: 0, align: deg === 180 ? "right" : deg === 0 ? "left" : "center" });
  });
  s.addText("→ 顺时针循环 →", { x: cx - 0.8, y: cy - 0.15, w: 1.6, h: 0.3, fontFace: F, fontSize: 9.5, color: GREY, isTextBox: true, margin: 0, align: "center" });
  frame(s, SH.mining, 5.1, 1.55, { w: 4.4, caption: "网站「因子挖掘」板块：选市场、门槛、轮数后开始循环（真实截图）" });
  card(s, 5.1, 3.55, 4.4, 1.55, "两句话", "① 不是多聊几轮：成绩单和错题本原样进入下一轮。\n② 打分的是程序：语法→IC→留出→重复→成本逐项检查，AI 不给自己打分。", VIOLET);
  s.addNotes("讲义 4.1–4.3。教练带学生的比喻；四步各自谁在做、产出什么。");

  // ---------------------------------------------------------------- 8 three rounds
  s = pres.addSlide(); title(s, "完整走一遍：三轮", "错误逐轮消失，方向逐轮迁移 —— 是错题本推的，不是 AI 自发的"); footer(s, 8);
  const H = (t) => ({ text: t, options: { bold: true, color: WHITE, fill: { color: INK }, fontSize: 9.5 } });
  const OK = (t) => ({ text: t, options: { color: GREEN, bold: true } }), NO = (t) => ({ text: t, options: { color: RED } });
  s.addTable([
    [H("轮"), H("候选（人话）"), H("评估结果"), H("写进错题本")],
    ["1", "rank(delta(close,20))　20 天涨幅排名", OK("样本内 0.024 · 留出 0.019 · 接受"), "—"],
    ["1", "rank(ts_mean(volume,500))　500 天均量", NO("窗口 > 120 · 语法拒绝"), "窗口必须在 1–120"],
    ["1", "rank(close/delay(close,20))　现价/20天前", NO("与第 1 条相关 0.99 · 重复拒绝"), "现价/过去价 与 价格变化量 是同一信号"],
    ["1", "rank(ts_std(close,10))　10 天波动率", NO("样本内 0.021 · 留出 −0.003 · 留出拒绝"), "短窗口波动率在本样本不成立"],
    ["1", "rank(ts_corr(close,volume,20))　量价相关", OK("样本内 0.016 · 留出 0.011 · 接受"), "—"],
    ["2", "量价背离、成交量相对变化、区间位置…", { text: "1 接受 · 2 因与量价族相关 0.8 拒绝", options: { color: AMBER } }, "量价相关族已覆盖，转向成交量自身变化"],
    ["3", "区间位置 × 成交量相对变化 等组合", NO("0 接受 —— 合法结果，不放水"), "新增两条；下次不必重踩"],
  ], { x: 0.5, y: 1.55, w: 9.0, colW: [0.4, 3.2, 2.7, 2.7], fontFace: F, fontSize: 9, color: INK, border: { type: "solid", pt: 0.5, color: "D6E4EC" }, fill: { color: WHITE }, rowH: 0.4, valign: "middle" });
  s.addText("第二轮的题目多了：两条已入库因子 + 三条教训 + 「动量以外，优先量价」的方向", { x: 0.5, y: 4.85, w: 9, h: 0.3, fontFace: F, fontSize: 10.5, color: GREY, isTextBox: true, margin: 0, italic: true });
  s.addNotes("讲义 4.4。数值为示意。重点：第三轮零接受是允许的。");

  // ---------------------------------------------------------------- 9 feedback boundary
  s = pres.addSlide(); title(s, "什么能进下一轮，什么绝对不能", "AI 可以知道「这条路不通」，不能知道「往哪边微调就能通过」"); footer(s, 9);
  const okList = ["已入库因子的表达式和样本内成绩", "被拒候选的一句话理由", "重复拒绝时和库里哪一条撞了", "留出集「过 / 没过」（只给二值）"];
  const noList = ["留出集的具体分数", "逐日 IC 序列"];
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.5, y: 1.55, w: 4.4, h: 2.35, rectRadius: 0.12, fill: { color: LIGHT }, line: { color: "D6E4EC", width: 0.75 } });
  s.addText("能进", { x: 0.7, y: 1.65, w: 3, h: 0.4, fontFace: F, fontSize: 14, bold: true, color: GREEN, isTextBox: true, margin: 0 });
  okList.forEach((t, i) => { s.addImage({ data: ICON["FiCheck:green"], x: 0.7, y: 2.12 + i * 0.4, w: 0.26, h: 0.26 }); s.addText(t, { x: 1.05, y: 2.08 + i * 0.4, w: 3.7, h: 0.34, fontFace: F, fontSize: 11, color: INK, isTextBox: true, margin: 0, valign: "middle" }); });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 5.1, y: 1.55, w: 4.4, h: 2.35, rectRadius: 0.12, fill: { color: "FDECEF" }, line: { color: "F3C6CE", width: 0.75 } });
  s.addText("绝对不能进", { x: 5.3, y: 1.65, w: 3, h: 0.4, fontFace: F, fontSize: 14, bold: true, color: RED, isTextBox: true, margin: 0 });
  noList.forEach((t, i) => { s.addImage({ data: ICON["FiX:red"], x: 5.3, y: 2.12 + i * 0.4, w: 0.26, h: 0.26 }); s.addText(t, { x: 5.65, y: 2.08 + i * 0.4, w: 3.7, h: 0.34, fontFace: F, fontSize: 11, color: INK, isTextBox: true, margin: 0, valign: "middle" }); });
  s.addText("一旦给了具体分数，AI 就能顺着它微调，留出集就变成了第二个样本内，整个验证失效。", { x: 5.3, y: 2.95, w: 4.0, h: 0.85, fontFace: F, fontSize: 10.5, color: RED, isTextBox: true, margin: 0 });
  s.addTable([
    [H("会坏在哪里"), H("为什么"), H("平台对策")],
    ["越找越像", "在成功方向上小修小改", "相关 > 0.7 拒绝；每轮要求新方向"],
    ["对着样本内背题", "反复看到样本内成绩", "留出一票否决，分数不进反馈"],
    ["为了有结果放水", "人和机器都想有产出", "允许零接受，不降门槛"],
  ], { x: 0.5, y: 4.05, w: 9.0, colW: [2.0, 3.0, 4.0], fontFace: F, fontSize: 9, color: INK, border: { type: "solid", pt: 0.5, color: "D6E4EC" }, fill: { color: WHITE }, rowH: 0.27, valign: "middle" });
  s.addNotes("讲义 4.5–4.7。演示：网站因子挖掘板块 LLM 引擎，每轮显示接受/拒绝理由，教训跨会话保存。");

  // ---------------------------------------------------------------- 10 GP
  s = pres.addSlide(); title(s, "另一条路：不用 AI 的进化搜索", "把表达式当作一棵树，随机组合、优胜劣汰、交叉变异"); footer(s, 10);
  const tnode = (t, x, y, c = CYAN, w = 1.15) => { s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h: 0.36, rectRadius: 0.1, fill: { color: c }, line: { color: c, width: 0 } }); s.addText(t, { x, y, w, h: 0.36, fontFace: "Courier New", fontSize: 10, bold: true, color: WHITE, isTextBox: true, margin: 0, align: "center", valign: "middle" }); };
  const edge = (x1, y1, x2, y2) => s.addShape(pres.shapes.LINE, { x: Math.min(x1, x2), y: y1, w: Math.abs(x2 - x1), h: y2 - y1, line: { color: "9FB3C8", width: 1.2 }, flipH: x2 < x1 });
  tnode("rank", 1.95, 1.6, INK); edge(2.52, 1.96, 2.52, 2.3);
  tnode("−", 1.95, 2.3, VIOLET); edge(2.52, 2.66, 1.4, 3.0); edge(2.52, 2.66, 3.6, 3.0);
  tnode("ts_rank", 0.85, 3.0, CYAN); tnode("ts_rank", 3.05, 3.0, CYAN);
  edge(1.42, 3.36, 0.9, 3.7); edge(1.42, 3.36, 1.95, 3.7); edge(3.62, 3.36, 3.1, 3.7); edge(3.62, 3.36, 4.15, 3.7);
  tnode("volume", 0.4, 3.7, GREEN, 1.0); tnode("10", 1.5, 3.7, AMBER, 0.85); tnode("close", 2.6, 3.7, GREEN, 1.0); tnode("10", 3.7, 3.7, AMBER, 0.85);
  s.addText("rank(ts_rank(volume,10) − ts_rank(close,10))\n进化 30 代后名人堂里的一条：量在涨、价还没跟上。人未必先想到，但拿到后解释得通。", { x: 0.5, y: 4.25, w: 4.4, h: 0.85, fontFace: F, fontSize: 10, color: GREY, isTextBox: true, margin: 0 });
  frame(s, SH.gp, 5.1, 1.55, { w: 4.4, caption: "进化实验室：冠军演化与名人堂实时刷新（真实截图）" });
  cardSm(s, 5.1, 4.0, 4.4, 1.1, "适应度里的三条修正", "稳定加分 · 每多一块积木扣一点分 · 和已发现因子太像的打对折。每代前 8 名进名人堂。", VIOLET, "FiAward");
  s.addNotes("讲义 5。两条路找法不同、判卷一样，产出进同一个因子库。");

  // ---------------------------------------------------------------- 11 portfolio
  s = pres.addSlide(); title(s, "从因子到组合：IC 好只是门票", "每 10 根 K 线按因子排序，买前 5 名等权，扣手续费与滑点，永远对比买入持有"); footer(s, 11);
  frame(s, SH.portfolio, 0.5, 1.55, { h: 3.35, caption: "真实回测：Top-5 组合 +69% vs 基准 +90%，夏普 1.03" });
  [["累计收益", "一定和基准放在一起看"], ["年化收益", "便于跨不同长度比较"], ["夏普比率", "1 以上不错，2 以上警惕过拟合"], ["最大回撤", "决定你能不能拿得住"]].forEach(([h, b], i) => {
    const x = 5.35 + (i % 2) * 2.15, y = 1.55 + Math.floor(i / 2) * 1.7;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 2.0, h: 1.55, rectRadius: 0.12, fill: { color: INK }, line: { color: INK, width: 0 } });
    s.addText(h, { x: x + 0.15, y: y + 0.15, w: 1.75, h: 0.45, fontFace: F, fontSize: 14, bold: true, color: CYAN_L, isTextBox: true, margin: 0 });
    s.addText(b, { x: x + 0.15, y: y + 0.62, w: 1.75, h: 0.85, fontFace: F, fontSize: 10, color: MIST, isTextBox: true, margin: 0 });
  });
  s.addNotes("讲义 6。为什么跑输：只买 5 只放大波动、每 10 天换仓吃收益、再平衡时点未必合适。IC 是门票，组合回测是成绩单。");

  // ---------------------------------------------------------------- 12 after go-live
  s = pres.addSlide(); title(s, "上线之后：因子会钝，要持续检查", "回测回答「过去行不行」，前向跟踪回答「你上线之后行不行」"); footer(s, 12);
  frame(s, SH.report, 0.5, 1.55, { h: 3.3, caption: "「体检」报告：五项评级 + 分层 + IC 衰减" });
  frame(s, SH.paper, 3.55, 1.55, { h: 3.3, caption: "模拟持仓：上线后 vs 回测期，判定「边际增强」" });
  cardSm(s, 6.55, 1.55, 2.95, 1.1, "衰减检测", "近 60 / 120 天 IC 明显低于全样本 = 钝了", AMBER, "FiTrendingUp");
  cardSm(s, 6.55, 2.75, 2.95, 1.1, "跨市场移植", "美股因子放到加密重算：两边都成立更像真规律", GREEN, "FiGlobe");
  cardSm(s, 6.55, 3.95, 2.95, 1.1, "前向跟踪", "上线前后夏普并排：保持 / 衰减 / 增强", CYAN, "FiPlayCircle");
  s.addNotes("讲义 7。这是真正的考试，回测错不了，是市场变了；及时降权或下线。");

  // ---------------------------------------------------------------- 13 rules
  s = pres.addSlide(); darkBg(s);
  s.addText("几条不能破的底线", { x: 0.6, y: 0.45, w: 8.8, h: 0.7, fontFace: F, fontSize: 26, bold: true, color: WHITE, isTextBox: true, margin: 0 });
  [["留出集只考一次", "样本内随便练，留出集从不进反馈。", "FiLock"], ["允许空手而归", "零接受是正常结果，说明这段数据在这个方向没有可靠信号。", "FiInbox"], ["基准永远在图上", "任何净值曲线旁边都有买入持有。", "FiBarChart2"], ["每一次拒绝都留痕", "被拒理由进错题本，供下一轮和下一个人看。", "FiFileText"], ["上线后继续考", "模拟持仓给出明确的衰减判定。", "FiEye"]].forEach(([h, b, ic], i) => {
    const y = 1.4 + i * 0.66;
    circleIcon(s, ic, 0.6, y, 0.5, i % 2 ? VIOLET : CYAN);
    s.addText(h, { x: 1.25, y, w: 2.6, h: 0.5, fontFace: F, fontSize: 14, bold: true, color: CYAN_L, isTextBox: true, margin: 0, valign: "middle" });
    s.addText(b, { x: 3.9, y, w: 5.5, h: 0.5, fontFace: F, fontSize: 12, color: MIST, isTextBox: true, margin: 0, valign: "middle" });
  });
  s.addImage({ data: ICON["FiAlertTriangle:amber"], x: 0.6, y: 4.78, w: 0.28, h: 0.28 });
  s.addText("三个坑：前视偏差（用了当时不可能知道的数据）· 幸存者偏差（样本只剩活到今天的公司）· 多重比较（试一千个总有几十个碰巧显著）", { x: 0.95, y: 4.72, w: 8.5, h: 0.45, fontFace: F, fontSize: 10, color: "AFC3DA", isTextBox: true, margin: 0, valign: "middle" });
  s.addNotes("讲义 8。多重比较最隐蔽，留出确认和重复度约束就是针对它。");

  // ---------------------------------------------------------------- 14 summary
  s = pres.addSlide(); title(s, "总结：三句话带走", "以及一份作业"); footer(s, 14);
  [["因子是给股票打分的规则，IC 是给规则打分的尺子。", "FiTarget", CYAN], ["Loop Engineering 的核心是把成绩单和错题本放回下一轮，同时把留出集的分数锁起来。", "FiRepeat", VIOLET], ["IC 是门票，组合回测是成绩单，上线后的前向跟踪才是最终考试。", "FiShield", GREEN]].forEach(([t, ic, c], i) => {
    const y = 1.55 + i * 0.95;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.5, y, w: 9, h: 0.8, rectRadius: 0.12, fill: { color: LIGHT }, line: { color: "D6E4EC", width: 0.75 } });
    circleIcon(s, ic, 0.65, y + 0.12, 0.56, c);
    s.addText(t, { x: 1.4, y, w: 7.9, h: 0.8, fontFace: F, fontSize: 13.5, color: INK, isTextBox: true, margin: 0, valign: "middle" });
  });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.5, y: 4.45, w: 9, h: 0.65, rectRadius: 0.1, fill: { color: INK }, line: { color: INK, width: 0 } });
  s.addText([{ text: "作业　", options: { bold: true, color: CYAN_L } }, { text: "用宽松档在加密市场跑一轮 LLM 挖掘，记录三轮里错题本的变化，200 字说明第三轮的题目比第一轮多了什么；再把接受的因子移植到美股，看 IC 变了多少。", options: { color: MIST } }], { x: 0.7, y: 4.45, w: 8.6, h: 0.65, fontFace: F, fontSize: 10.5, isTextBox: true, margin: 0, valign: "middle" });
  s.addNotes("讲义 9。收尾 30 秒。");

  await pres.writeFile({ fileName: "因子挖掘-15分钟.pptx" });
  console.log("wrote pptx");
})();
