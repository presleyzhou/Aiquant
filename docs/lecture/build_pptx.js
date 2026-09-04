const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pres.title = "因子挖掘 15 分钟";

const NAVY = "0B1020", INK = "13213A", CYAN = "0FA8C9", CYAN_L = "3BE0FF", VIOLET = "7C5CFF", GREY = "6B7A90", LIGHT = "EEF6FA", WHITE = "FFFFFF", AMBER = "F0A500", GREEN = "1FA971", RED = "D9485F";
const F = "Microsoft YaHei";

function darkBg(s) {
  s.background = { color: NAVY };
  // subtle grid dots motif
  for (let i = 0; i < 14; i++) for (let j = 0; j < 8; j++)
    s.addShape(pres.shapes.OVAL, { x: 0.35 + i * 0.7, y: 0.35 + j * 0.7, w: 0.04, h: 0.04, fill: { color: "1E3352" }, line: { color: "1E3352", width: 0 } });
}
function title(s, text, sub) {
  s.addText(text, { x: 0.5, y: 0.35, w: 9, h: 0.7, fontFace: F, fontSize: 30, bold: true, color: INK, isTextBox: true, margin: 0 });
  if (sub) s.addText(sub, { x: 0.5, y: 1.0, w: 9, h: 0.4, fontFace: F, fontSize: 13, color: GREY, isTextBox: true, margin: 0 });
}
function numCircle(s, n, x, y, color = CYAN) {
  s.addShape(pres.shapes.OVAL, { x, y, w: 0.42, h: 0.42, fill: { color }, line: { color, width: 0 } });
  s.addText(String(n), { x, y, w: 0.42, h: 0.42, fontFace: F, fontSize: 14, bold: true, color: WHITE, align: "center", valign: "middle", isTextBox: true, margin: 0 });
}
function card(s, x, y, w, h, head, body, color = CYAN) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: LIGHT }, line: { color: "D6E4EC", width: 0.75 } });
  s.addText(head, { x: x + 0.2, y: y + 0.15, w: w - 0.4, h: 0.4, fontFace: F, fontSize: 15, bold: true, color, isTextBox: true, margin: 0 });
  s.addText(body, { x: x + 0.2, y: y + 0.58, w: w - 0.4, h: h - 0.7, fontFace: F, fontSize: 11.5, color: INK, isTextBox: true, margin: 0, valign: "top" });
}
function footer(s, n) {
  s.addText(`AIQUANT TERMINAL · 因子挖掘 · ${n}/12`, { x: 0.5, y: 5.2, w: 9, h: 0.3, fontFace: F, fontSize: 9, color: GREY, isTextBox: true, margin: 0, align: "right" });
}
function code(s, text, x, y, w, h) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.08, fill: { color: INK }, line: { color: INK, width: 0 } });
  s.addText(text, { x: x + 0.15, y: y + 0.08, w: w - 0.3, h: h - 0.16, fontFace: "Courier New", fontSize: 11.5, color: CYAN_L, isTextBox: true, margin: 0, valign: "middle" });
}

// 1 封面
let s = pres.addSlide(); darkBg(s);
s.addText("因子挖掘", { x: 0.7, y: 1.4, w: 8.6, h: 1.0, fontFace: F, fontSize: 48, bold: true, color: WHITE, isTextBox: true, margin: 0 });
s.addText("从一条表达式到一个可上线的组合 —— 15 分钟", { x: 0.7, y: 2.4, w: 8.6, h: 0.5, fontFace: F, fontSize: 20, color: CYAN_L, isTextBox: true, margin: 0 });
s.addText("以 AIQUANT TERMINAL 的「因子挖掘」板块为教学载体：LLM 循环工程 + 遗传算法进化，全程样本外验证", { x: 0.7, y: 3.1, w: 8.4, h: 0.6, fontFace: F, fontSize: 13, color: "AFC3DA", isTextBox: true, margin: 0 });
s.addText("aiquant-rust.vercel.app · 因子挖掘", { x: 0.7, y: 4.7, w: 6, h: 0.3, fontFace: F, fontSize: 11, color: GREY, isTextBox: true, margin: 0 });
s.addNotes("开场 30 秒：今天只回答一个问题——怎样让机器帮我们找到「能预测未来收益的信号」，并且不被自己骗。整堂课跟着网站的因子挖掘板块走一遍。");

// 2 什么是因子
s = pres.addSlide(); title(s, "什么是因子？", "一个对每只股票、每一天都能算出的数字，它的高低应当与未来收益的高低有关"); footer(s, 2);
code(s, "rank(delta(close, 20))\n= 「20 日涨幅」在全市场的横截面排名", 0.5, 1.6, 5.2, 1.0);
s.addText([
  { text: "横截面：", options: { bold: true, color: CYAN } }, { text: "同一天比较所有标的，而不是一只标的的时间序列。", options: { breakLine: true } },
  { text: "预测性：", options: { bold: true, color: CYAN } }, { text: "今天因子值高的标的，未来 N 天收益是否更高？", options: { breakLine: true } },
  { text: "可实施：", options: { bold: true, color: CYAN } }, { text: "只能用当天及以前的数据，不能偷看未来。", options: {} },
], { x: 0.5, y: 2.85, w: 5.2, h: 1.8, fontFace: F, fontSize: 13, color: INK, isTextBox: true, margin: 0, paraSpaceAfter: 8 });
card(s, 6.1, 1.6, 3.4, 3.1, "衡量尺子：IC", "IC（信息系数）= 当天因子排名与未来收益排名的 Spearman 相关。\n\n每天算一个 IC，得到一条 IC 序列：\n• 均值 |IC| 越大 → 越有预测力\n• ICIR = 均值 / 标准差 → 越稳定\n\n经验上 |IC| ≥ 0.02 已经值得认真看。", VIOLET);
s.addNotes("2 分钟。强调横截面与时间序列的区别；IC 是全课的尺子。举例：动量因子在美股 60 只样本上日 IC 常在 0.01-0.03。");

// 3 DSL
s = pres.addSlide(); title(s, "表达式即因子：一门受限的小语言", "网站里所有因子都是这门 DSL 的合法表达式——机器能生成、能校验、能解释"); footer(s, 3);
const ops = [["时序算子", "ts_mean ts_std ts_sum ts_min ts_max ts_rank delay delta ts_corr", CYAN], ["横截面算子", "rank zscore", VIOLET], ["逐元素算子", "sign abs log sqrt neg  + − × ÷", AMBER], ["原始字段", "open high low close volume", GREEN]];
ops.forEach(([h, b, c], i) => card(s, 0.5 + (i % 2) * 4.6, 1.6 + Math.floor(i / 2) * 1.35, 4.4, 1.2, h, b, c));
s.addText([
  { text: "安全边界（服务器端强制）：", options: { bold: true, color: INK, breakLine: true } },
  { text: "长度 ≤ 240 字符 · 嵌套深度 ≤ 10 · 窗口 1–120 · 手写解析器，绝不 eval", options: { bullet: true, breakLine: true } },
  { text: "全 NaN 或常数因子直接拒绝 —— close/close 这类「零信息」表达式进不了评估", options: { bullet: true } },
], { x: 0.5, y: 4.35, w: 9, h: 0.8, fontFace: F, fontSize: 11.5, color: INK, isTextBox: true, margin: 0 });
s.addNotes("1 分钟。DSL 的意义：让 LLM 和遗传算法在同一个搜索空间里工作，且每个候选都能被确定性地计算与审计。");

// 4 评估流水线
s = pres.addSlide(); title(s, "评估流水线：每个候选都走同一条路", "样本内看强度，留出集只做确认——留出集从不参与反馈"); footer(s, 4);
const steps = ["解析 & 校验", "全样本计算因子面板", "逐日 rank IC → IC 序列", "前 80% 样本内：|IC|、ICIR", "后 20% 留出：同号且达标才接受"];
steps.forEach((t, i) => {
  const x = 0.5 + i * 1.85;
  numCircle(s, i + 1, x, 1.7);
  s.addText(t, { x, y: 2.2, w: 1.7, h: 0.9, fontFace: F, fontSize: 11.5, color: INK, isTextBox: true, margin: 0, bold: i === 4 });
  if (i < 4) s.addText("→", { x: x + 1.45, y: 1.68, w: 0.4, h: 0.42, fontFace: F, fontSize: 16, color: GREY, isTextBox: true, margin: 0, align: "center", valign: "middle" });
});
s.addChart(pres.charts.BAR, [
  { name: "样本内 IC", labels: ["候选 A", "候选 B", "候选 C", "候选 D"], values: [0.031, 0.024, 0.019, 0.022] },
  { name: "留出 IC", labels: ["候选 A", "候选 B", "候选 C", "候选 D"], values: [0.027, -0.004, 0.017, 0.006] },
], { x: 0.5, y: 3.15, w: 5.6, h: 2.0, barDir: "col", chartColors: [CYAN, VIOLET], showTitle: true, title: "示意：样本内漂亮 ≠ 留出集成立（B、D 被拒）", titleFontSize: 10, titleColor: INK, titleFontFace: F,
  showValue: true, dataLabelPosition: "outEnd", dataLabelFontSize: 8, dataLabelFormatCode: "0.000", dataLabelColor: INK,
  catAxisLabelColor: GREY, valAxisLabelColor: GREY, catAxisLabelFontSize: 9, valAxisLabelFontSize: 8, valGridLine: { color: "E3ECF2", size: 0.5 }, catGridLine: { style: "none" }, showLegend: true, legendPos: "b", legendFontSize: 9, legendColor: GREY, valAxisLabelFormatCode: "0.00" });
card(s, 6.4, 3.15, 3.1, 2.0, "为什么 80/20？", "LLM 每一轮都拿到样本内成绩作反馈，久了就会「对着答案写」。\n\n留出集是它永远看不到的考卷：样本内 0.03、留出 −0.004 的候选（B）就是过拟合的典型面孔。", RED);
s.addNotes("2 分钟。图是示意数据。关键句：留出集不是第二个训练集，是唯一一次考试。");

// 5 门槛
s = pres.addSlide(); title(s, "门槛自适应：三档标准", "同一条流水线，三套录取线。市场噪声大时放宽，数据干净时收紧"); footer(s, 5);
const modes = [["strict 严格", "|IC| ≥ 0.020", "ICIR ≥ 0.25", "论文级要求，产出少而精", RED], ["standard 标准", "|IC| ≥ 0.015", "ICIR ≥ 0.15", "默认档；美股日频的合理水位", CYAN], ["loose 宽松", "|IC| ≥ 0.010", "ICIR ≥ 0.08", "加密 24×7 噪声更大时的起步档", GREEN]];
modes.forEach(([h, ic, icir, note, c], i) => {
  const x = 0.5 + i * 3.1;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.6, w: 2.9, h: 3.0, rectRadius: 0.12, fill: { color: LIGHT }, line: { color: "D6E4EC", width: 0.75 } });
  s.addText(h, { x: x + 0.2, y: 1.75, w: 2.5, h: 0.4, fontFace: F, fontSize: 15, bold: true, color: c, isTextBox: true, margin: 0 });
  s.addText(ic, { x: x + 0.2, y: 2.25, w: 2.5, h: 0.6, fontFace: F, fontSize: 24, bold: true, color: INK, isTextBox: true, margin: 0 });
  s.addText(icir, { x: x + 0.2, y: 2.9, w: 2.5, h: 0.5, fontFace: F, fontSize: 18, color: INK, isTextBox: true, margin: 0 });
  s.addText(note, { x: x + 0.2, y: 3.55, w: 2.5, h: 0.9, fontFace: F, fontSize: 11.5, color: GREY, isTextBox: true, margin: 0 });
});
s.addText("留出集要求：与样本内同号，且 |IC| 不低于样本内门槛的一半。三档都不豁免这一条。", { x: 0.5, y: 4.75, w: 9, h: 0.4, fontFace: F, fontSize: 12, color: INK, isTextBox: true, margin: 0, italic: true });
s.addNotes("1 分钟。让学生猜：为什么加密用 loose？答：24×7、样本只有 24 个币、噪声更大；标准不是越严越好，而是与数据匹配。");

// 6 Loop engineering
s = pres.addSlide(); title(s, "循环工程：让上一轮的结果改写下一轮的提示", "Chain-of-Alpha 式的 LLM 挖掘循环——不是让模型「多想」，而是让它「看到成绩单」"); footer(s, 6);
const loop = [["生成", "LLM 依据假设库、已接受因子和历史教训，一次给出 N 条候选表达式", CYAN], ["评估", "同一条 IC 流水线，逐条打分；语法错、NaN、冗余全部记账", VIOLET], ["反思", "把「什么被拒、为什么」写成教训（lessons），跨会话持久保存", AMBER], ["更新", "下一轮提示词 = 目标 + 已有因子 + 教训 + 本轮新方向", GREEN]];
loop.forEach(([h, b, c], i) => {
  const x = 0.5 + (i % 2) * 4.7, y = 1.6 + Math.floor(i / 2) * 1.55;
  numCircle(s, i + 1, x, y + 0.1, c);
  s.addText(h, { x: x + 0.55, y: y + 0.05, w: 3.9, h: 0.4, fontFace: F, fontSize: 15, bold: true, color: c, isTextBox: true, margin: 0 });
  s.addText(b, { x: x + 0.55, y: y + 0.5, w: 3.9, h: 0.9, fontFace: F, fontSize: 11.5, color: INK, isTextBox: true, margin: 0 });
});
s.addText("跨次记忆：接受过的因子和教训保存在本地，下次挖掘直接续上；被拒因子不会被反复重新发明。", { x: 0.5, y: 4.75, w: 9, h: 0.4, fontFace: F, fontSize: 12, color: GREY, isTextBox: true, margin: 0 });
s.addNotes("2 分钟。区分「循环工程」和「多轮对话」：前者的核心是评估器给出的结构化反馈进入下一轮上下文。演示：网站因子挖掘板块选 LLM 引擎，看每轮接受/拒绝理由。");

// 7 GP
s = pres.addSlide(); title(s, "遗传算法进化：不靠语言模型的另一条路", "把表达式当作语法树，用选择、交叉、变异在 DSL 空间里搜索"); footer(s, 7);
s.addText([
  { text: "种群：", options: { bold: true, color: CYAN } }, { text: "随机生成的语法树（含种子因子）", options: { breakLine: true } },
  { text: "交叉：", options: { bold: true, color: CYAN } }, { text: "交换两棵树的子树", options: { breakLine: true } },
  { text: "变异：", options: { bold: true, color: CYAN } }, { text: "改窗口、换算子、替换子树", options: { breakLine: true } },
  { text: "化简：", options: { bold: true, color: CYAN } }, { text: "ts_min(ts_min(x)) → ts_min(x)，抑制膨胀", options: { breakLine: true } },
  { text: "名人堂：", options: { bold: true, color: CYAN } }, { text: "保留 8 个最优且互不冗余的个体", options: {} },
], { x: 0.5, y: 1.6, w: 4.4, h: 2.6, fontFace: F, fontSize: 12.5, color: INK, isTextBox: true, margin: 0, paraSpaceAfter: 6 });
code(s, "fitness = |IC| × (0.6 + 0.4·min(1, |ICIR| / 0.5))\n         − 0.02 × (1 − 稳定性)\n         − 0.0015 × 节点数\n若与名人堂相关 > 0.7：fitness × 0.5", 5.1, 1.6, 4.4, 1.6);
card(s, 5.1, 3.4, 4.4, 1.7, "适应度为什么长这样", "|IC| 是主项；ICIR 给稳定的因子加成；每个节点扣一点分（简约惩罚）；与已发现因子太像的个体被打对折（生态位保护），逼着种群去探索新方向。", VIOLET);
s.addNotes("2 分钟。可讲 Koza 的遗传编程渊源。网站里 GP 引擎每一代都实时推送名人堂和冠军曲线，进化结束列出发现的因子与稳定性。");

// 8 去冗余
s = pres.addSlide(); title(s, "去冗余与简约：因子库不是越多越好", "十个 0.9 相关的动量因子 ≈ 一个动量因子。库里要的是「不同的信息」"); footer(s, 8);
card(s, 0.5, 1.6, 2.9, 2.2, "相关性 ≤ 0.7", "新因子与库中任一已接受因子的因子值相关系数超过 0.7 即拒绝，理由写入教训。", CYAN);
card(s, 3.55, 1.6, 2.9, 2.2, "复杂度 ≤ 24", "语法树节点数上限，AlphaAgent 式正则：解释得清的因子才有人敢用。", VIOLET);
card(s, 6.6, 1.6, 2.9, 2.2, "必须含变换", "裸 volume、裸 close 这种「规模代理」不算因子；至少要经过一个时序或横截面算子。", AMBER);
s.addText([
  { text: "课堂提问：", options: { bold: true, color: INK } },
  { text: "rank(delta(close,20)) 与 rank(close/delay(close,20)) 相关多高？为什么库里只留一个？", options: {} },
], { x: 0.5, y: 4.1, w: 9, h: 0.5, fontFace: F, fontSize: 13, color: INK, isTextBox: true, margin: 0 });
s.addText("答：几乎完全相关（都是 20 日动量的单调变换），第二个会因冗余被拒。", { x: 0.5, y: 4.65, w: 9, h: 0.4, fontFace: F, fontSize: 12, color: GREY, isTextBox: true, margin: 0, italic: true });
s.addNotes("1 分钟。这是学生最容易忽略的一环：IC 高但冗余的因子对组合几乎零增量。");

// 9 因子→组合
s = pres.addSlide(); title(s, "从因子到组合：IC 好看不等于能赚钱", "Top-N 等权、定期再平衡、始终对比买入持有基准"); footer(s, 9);
steps2 = [["排序", "每个再平衡日按因子值排序（可反向）"], ["选股", "取前 N 名等权持有"], ["再平衡", "每 10 根 K 线换仓一次，计入换手"], ["对比", "同期等权买入持有作为基准"]];
steps2.forEach(([h, b], i) => { numCircle(s, i + 1, 0.5, 1.65 + i * 0.72, i % 2 ? VIOLET : CYAN); s.addText([{ text: h + "  ", options: { bold: true } }, { text: b, options: {} }], { x: 1.05, y: 1.65 + i * 0.72, w: 3.9, h: 0.5, fontFace: F, fontSize: 12.5, color: INK, isTextBox: true, margin: 0, valign: "middle" }); });
const stats = [["累计收益", "vs 基准"], ["年化收益", "CAGR"], ["夏普比率", "风险调整后"], ["最大回撤", "最痛的一段"]];
stats.forEach(([h, b], i) => {
  const x = 5.2 + (i % 2) * 2.2, y = 1.6 + Math.floor(i / 2) * 1.45;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 2.05, h: 1.3, rectRadius: 0.12, fill: { color: INK }, line: { color: INK, width: 0 } });
  s.addText(h, { x: x + 0.15, y: y + 0.2, w: 1.8, h: 0.45, fontFace: F, fontSize: 16, bold: true, color: CYAN_L, isTextBox: true, margin: 0 });
  s.addText(b, { x: x + 0.15, y: y + 0.7, w: 1.8, h: 0.4, fontFace: F, fontSize: 11, color: "AFC3DA", isTextBox: true, margin: 0 });
});
s.addText("网站的「组合回测」「进化实验室」都展示这四个数字，且基准曲线永远与策略曲线同图。", { x: 0.5, y: 4.7, w: 9, h: 0.4, fontFace: F, fontSize: 12, color: GREY, isTextBox: true, margin: 0 });
s.addNotes("1.5 分钟。强调：一个 IC=0.03 的因子在 Top-5 组合里可能跑不赢基准——换手成本、集中度、择时都在吃收益。");

// 10 合成/衰减/移植
s = pres.addSlide(); title(s, "库建好之后的三件事", "多因子合成 · 衰减监控 · 跨市场移植"); footer(s, 10);
card(s, 0.5, 1.6, 2.9, 3.2, "多因子合成", "把多个低相关因子按 rank 等权（或按 IC 加权）叠加成一个复合信号，再跑同一条组合回测。\n\n目的：分散单因子失效的风险。", CYAN);
card(s, 3.55, 1.6, 2.9, 3.2, "衰减监控", "把 IC 序列按时间切段（近 60 / 120 / 全样本），看近端是否明显低于远端。\n\n因子会被市场学走；发现衰减就该降权或下线。", AMBER);
card(s, 6.6, 1.6, 2.9, 3.2, "跨市场移植", "美股上挖到的因子，直接放到加密样本上重算 IC。\n\n两边都成立 → 更像真规律；只在一边成立 → 可能是样本特性。", GREEN);
s.addNotes("1.5 分钟。这三项在网站里对应「合成」「检查」两个按钮。可以现场演示一个美股动量因子移植到加密的结果。");

// 11 诚实原则
s = pres.addSlide(); darkBg(s);
s.addText("诚实原则：机器挖矿最大的风险是骗自己", { x: 0.6, y: 0.5, w: 8.8, h: 0.7, fontFace: F, fontSize: 26, bold: true, color: WHITE, isTextBox: true, margin: 0 });
const rules = [["留出集只考一次", "样本内可以反复迭代，留出集永远不进反馈。"], ["允许空手而归", "一轮下来零因子被接受是合法结果，界面会解释原因而不是凑数。"], ["基准永远在图上", "任何净值曲线旁边都有买入持有；不展示「绝对收益」独舞。"], ["记录每一次拒绝", "被拒理由进入教训库，供下一轮和下一个人阅读。"], ["上线后继续考", "模拟持仓对比上线前后的夏普，给出「衰减 / 保持」判定。"]];
rules.forEach(([h, b], i) => {
  const y = 1.45 + i * 0.72;
  numCircle(s, i + 1, 0.6, y, i % 2 ? VIOLET : CYAN);
  s.addText(h, { x: 1.15, y: y - 0.02, w: 2.6, h: 0.45, fontFace: F, fontSize: 14, bold: true, color: CYAN_L, isTextBox: true, margin: 0, valign: "middle" });
  s.addText(b, { x: 3.8, y: y - 0.02, w: 5.6, h: 0.45, fontFace: F, fontSize: 12, color: "DCE7F2", isTextBox: true, margin: 0, valign: "middle" });
});
s.addText("常见坑：前视偏差（用了未来数据）· 幸存者偏差（样本只剩活下来的公司）· 多重比较（试 1000 个总有 50 个显著）", { x: 0.6, y: 5.05, w: 8.8, h: 0.4, fontFace: F, fontSize: 10.5, color: "AFC3DA", isTextBox: true, margin: 0, italic: true });
s.addNotes("1.5 分钟。多重比较是重点：Harvey-Liu-Zhu 建议 t 统计量门槛提到 3.0。这就是为什么网站把留出集确认设为硬门槛。");

// 12 总结 + 演示路线
s = pres.addSlide(); title(s, "总结与 5 分钟上手路线", "打开网站 → 因子挖掘 → 跟着做"); footer(s, 12);
const demo = ["选择市场（美股 / 加密）与门槛档（先 standard）", "选 LLM 引擎看接受 / 拒绝理由，或选 GP 看名人堂刷新", "把接受的因子点「组合回测」，读四个数字并与基准比较", "点「检查」：看衰减曲线与跨市场移植结果", "点「上线」到模拟持仓，一周后回来看衰减判定"];
demo.forEach((t, i) => { numCircle(s, i + 1, 0.5, 1.6 + i * 0.62, i % 2 ? VIOLET : CYAN); s.addText(t, { x: 1.05, y: 1.6 + i * 0.62, w: 5.2, h: 0.5, fontFace: F, fontSize: 12.5, color: INK, isTextBox: true, margin: 0, valign: "middle" }); });
s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 6.4, y: 1.6, w: 3.1, h: 3.1, rectRadius: 0.12, fill: { color: INK }, line: { color: INK, width: 0 } });
s.addText("三句话带走", { x: 6.6, y: 1.75, w: 2.7, h: 0.4, fontFace: F, fontSize: 15, bold: true, color: CYAN_L, isTextBox: true, margin: 0 });
s.addText([
  { text: "因子 = 表达式 + 横截面 IC。", options: { bullet: true, breakLine: true } },
  { text: "搜索靠 LLM 循环或遗传进化，录取靠留出集。", options: { bullet: true, breakLine: true } },
  { text: "IC 只是门票，组合回测和上线后的衰减才是成绩。", options: { bullet: true } },
], { x: 6.6, y: 2.25, w: 2.7, h: 2.3, fontFace: F, fontSize: 12, color: "DCE7F2", isTextBox: true, margin: 0, paraSpaceAfter: 8 });
s.addNotes("1 分钟收尾。留作业：用 loose 档在加密市场跑一轮 GP，把发现的因子移植到美股，记录 IC 变化并解释。");

pres.writeFile({ fileName: "因子挖掘-15分钟.pptx" }).then((f) => console.log("wrote", f));
