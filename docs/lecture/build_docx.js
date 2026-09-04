const fs = require("fs");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, BorderStyle, LevelFormat, PageBreak, TableOfContents } = require("docx");

const F = "Microsoft YaHei";
const NAVY = "13213A", CYAN = "0FA8C9", GREY = "6B7A90";
const p = (text, opts = {}) => new Paragraph({ spacing: { after: 120, line: 320 }, ...opts.para, children: Array.isArray(text) ? text : [new TextRun({ text, font: F, size: 21, color: NAVY, ...opts.run })] });
const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 120 }, children: [new TextRun({ text: t, font: F, size: 30, bold: true, color: NAVY })] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 }, children: [new TextRun({ text: t, font: F, size: 24, bold: true, color: CYAN })] });
const bullet = (t, ref = "bullets") => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 80, line: 300 }, children: typeof t === "string" ? [new TextRun({ text: t, font: F, size: 21, color: NAVY })] : t });
const b = (t) => new TextRun({ text: t, font: F, size: 21, bold: true, color: NAVY });
const r = (t) => new TextRun({ text: t, font: F, size: 21, color: NAVY });
const code = (t) => new Paragraph({ spacing: { after: 120 }, shading: { type: ShadingType.CLEAR, fill: "EEF6FA", color: "auto" }, indent: { left: 360 }, children: [new TextRun({ text: t, font: "Courier New", size: 19, color: NAVY })] });
const note = (t) => p([new TextRun({ text: t, font: F, size: 19, italics: true, color: GREY })]);

function table(headers, rows, widths) {
  const total = widths.reduce((a, c) => a + c, 0);
  const cell = (t, head, w) => new TableCell({ width: { size: w, type: WidthType.DXA }, shading: head ? { type: ShadingType.CLEAR, fill: "13213A", color: "auto" } : undefined, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: [new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: t, font: F, size: 19, bold: head, color: head ? "FFFFFF" : NAVY })] })] });
  return new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: widths, rows: [new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, true, widths[i])) }), ...rows.map((row) => new TableRow({ children: row.map((c, i) => cell(c, false, widths[i])) }))] });
}
const gap = () => new Paragraph({ spacing: { after: 60 }, children: [] });

const doc = new Document({
  styles: { default: { document: { run: { font: F, size: 21 } } } },
  numbering: { config: [
    { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
    { reference: "steps", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
    { reference: "steps2", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
  ] },
  sections: [{
    properties: { page: { margin: { top: 1300, bottom: 1300, left: 1400, right: 1400 } } },
    children: [
      new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "因子挖掘：从一条表达式到一个可上线的组合", font: F, size: 40, bold: true, color: NAVY })] }),
      new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "15 分钟讲义 · 以 AIQUANT TERMINAL「因子挖掘」板块为教学载体", font: F, size: 24, color: CYAN })] }),
      note("适用对象：有基础统计与编程概念、初次接触量化因子研究的学生或同事。配套幻灯片 12 页；本讲义含逐节讲稿、时间安排、课堂演示步骤、术语表与讨论题。"),
      gap(),
      h1("一、课程目标与时间安排"),
      p("讲完 15 分钟，听众应能：（1）说出「因子」与「IC」的定义并读懂一条 DSL 表达式；（2）解释为什么留出集不能参与反馈；（3）比较 LLM 循环工程与遗传算法两种搜索方式；（4）知道 IC 只是门票，组合回测与上线后衰减才是成绩。"),
      table(["时间", "环节", "对应幻灯片", "讲授要点"], [
        ["0:00–0:30", "开场", "1", "只回答一个问题：怎样让机器找到能预测收益的信号，且不骗自己"],
        ["0:30–2:30", "什么是因子 / IC", "2", "横截面 vs 时间序列；IC、ICIR 的定义与量级"],
        ["2:30–3:30", "表达式即因子（DSL）", "3", "算子家族；服务器端安全边界；零信息因子被拒"],
        ["3:30–5:30", "评估流水线与留出集", "4", "80/20 划分；留出集只考一次；过拟合的面孔"],
        ["5:30–6:30", "三档门槛", "5", "strict / standard / loose 的数值与适用场景"],
        ["6:30–8:30", "LLM 循环工程", "6", "生成→评估→反思→更新；跨次记忆"],
        ["8:30–10:30", "遗传算法进化", "7", "语法树、交叉变异、适应度公式、名人堂与生态位"],
        ["10:30–11:30", "去冗余与简约", "8", "相关 0.7、复杂度 24、必须含变换"],
        ["11:30–13:00", "因子→组合", "9", "Top-N 等权、再平衡、四个数字、基准同图"],
        ["13:00–14:00", "合成 / 衰减 / 移植 + 诚实原则", "10–11", "库建好后的三件事；五条诚实原则；三个常见坑"],
        ["14:00–15:00", "总结与上手路线", "12", "三句话带走；5 分钟演示路线；作业"],
      ], [1300, 2100, 1300, 4740]),
      gap(),
      h1("二、逐节讲稿"),
      h2("1. 什么是因子（2 分钟）"),
      p("因子是一个「对每只标的、每一天都能算出来」的数字，它的高低应当与未来收益的高低有关。关键词是横截面：我们不是在预测一只股票明天涨不涨，而是在同一天把所有标的排个序，看排在前面的那批未来是否整体跑赢排在后面的那批。"),
      code("rank(delta(close, 20))   # 20 日涨幅在全市场中的横截面排名——最朴素的动量因子"),
      p([b("IC（信息系数）"), r("：当天因子排名与未来 N 天收益排名之间的 Spearman 相关系数。每天算一个，就得到一条 IC 序列。均值 |IC| 衡量预测力，ICIR = 均值 / 标准差衡量稳定性。日频美股上 |IC| 达到 0.02 已经值得认真对待，0.05 以上就要怀疑是不是哪里偷看了未来。")]),
      note("板书建议：画一个 60 行（标的）× 1 列（因子值）的表，旁边再画一列「未来 10 日收益」，用箭头表示两列排名之间的相关。"),
      h2("2. 表达式即因子：一门受限的小语言（1 分钟）"),
      p("网站里所有因子都是一门小型 DSL 的合法表达式。这样做的意义是：LLM 和遗传算法在同一个搜索空间里工作，每个候选都能被确定性地计算、校验和解释。"),
      table(["算子家族", "成员", "作用"], [
        ["时序算子", "ts_mean ts_std ts_sum ts_min ts_max ts_rank delay delta ts_corr", "沿时间轴滚动计算，窗口 1–120"],
        ["横截面算子", "rank zscore", "同一天在所有标的之间标准化"],
        ["逐元素算子", "sign abs log sqrt neg，以及 + − × ÷", "无状态变换"],
        ["原始字段", "open high low close volume", "唯一的输入"],
      ], [1700, 4600, 3140]),
      p([b("安全边界"), r("：长度不超过 240 字符、嵌套深度不超过 10、窗口 1–120；解析器是手写的，绝不 eval。全 NaN 或常数的因子（例如 close/close）在评估前就被拒绝，因为它们不携带任何横截面信息。")]),
      h2("3. 评估流水线与留出集（2 分钟）"),
      p("每个候选都走同一条路：解析校验 → 在全样本面板上计算因子值 → 逐日 rank IC 得到 IC 序列 → 用前 80% 时间算样本内 |IC| 与 ICIR → 用后 20% 的留出窗口做确认：符号必须与样本内一致，且 |IC| 不低于样本内门槛的一半。"),
      p([b("留出集从不参与反馈"), r("。LLM 每一轮都拿到样本内成绩，久了就会「对着答案写」；留出集是它永远看不到的考卷。幻灯片第 4 页的示意图里，候选 B 样本内 0.024、留出 −0.004，就是过拟合最典型的面孔。")]),
      note("常见追问：为什么不用 K 折交叉验证？答：时间序列有顺序，随机切分会让未来信息泄漏到训练侧；按时间切一次并只考一次，是最朴素也最难作弊的做法。"),
      h2("4. 三档门槛（1 分钟）"),
      table(["档位", "样本内 |IC|", "样本内 ICIR", "适用场景"], [
        ["strict 严格", "≥ 0.020", "≥ 0.25", "论文级要求；产出少而精"],
        ["standard 标准", "≥ 0.015", "≥ 0.15", "默认档；美股日频的合理水位"],
        ["loose 宽松", "≥ 0.010", "≥ 0.08", "加密 24×7、样本仅 24 个币、噪声更大时的起步档"],
      ], [1900, 1900, 1900, 3740]),
      p("标准不是越严越好，而是与数据匹配。让学生猜「为什么加密要用宽松档」，是很好的互动点。"),
      h2("5. LLM 循环工程（2 分钟）"),
      p("Chain-of-Alpha 一类工作的核心不是让模型「想得更久」，而是让评估器的结构化结果进入下一轮的上下文。网站的循环分四步："),
      bullet([b("生成 "), r("：LLM 依据假设库、已接受因子和历史教训，一次给出若干条候选表达式。")]),
      bullet([b("评估 "), r("：同一条 IC 流水线逐条打分；语法错误、NaN、冗余全部记账。")]),
      bullet([b("反思 "), r("：把「什么被拒、为什么」写成教训（lessons），跨会话持久保存。")]),
      bullet([b("更新 "), r("：下一轮提示词 = 目标 + 已有因子 + 教训 + 本轮新方向。")]),
      p("跨次记忆保证被拒因子不会被反复重新发明，接受过的因子成为后续冗余检查的参照。"),
      h2("6. 遗传算法进化（2 分钟）"),
      p("另一条不依赖语言模型的路：把表达式当作语法树，用选择、交叉（交换子树）、变异（改窗口、换算子、替换子树）在 DSL 空间里搜索。化简步骤把 ts_min(ts_min(x)) 之类的膨胀压回去。名人堂保留 8 个最优且互不冗余的个体，每一代实时刷新。"),
      code("fitness = |IC| × (0.6 + 0.4 · min(1, |ICIR| / 0.5))\n         − 0.02 × (1 − 稳定性)\n         − 0.0015 × 语法树节点数\n若与名人堂中任一因子相关 > 0.7，则 fitness × 0.5"),
      p("|IC| 是主项；ICIR 给稳定因子加成；每个节点扣一点分是简约惩罚；与已发现因子太像的个体被打对折，这是生态位保护，逼着种群探索新方向。"),
      h2("7. 去冗余与简约（1 分钟）"),
      bullet([b("相关性 ≤ 0.7 "), r("：与库中任一已接受因子的因子值相关超过 0.7 即拒绝。")]),
      bullet([b("复杂度 ≤ 24 "), r("：语法树节点数上限，解释得清的因子才有人敢用。")]),
      bullet([b("必须含变换 "), r("：裸 volume、裸 close 是规模代理而非因子，至少要经过一个时序或横截面算子。")]),
      p("课堂提问：rank(delta(close,20)) 与 rank(close/delay(close,20)) 相关多高？答：几乎完全相关，二者都是 20 日动量的单调变换，第二个会因冗余被拒。"),
      h2("8. 从因子到组合（1.5 分钟）"),
      p("IC 好看不等于能赚钱。组合回测的做法：每个再平衡日按因子值排序（可反向），取前 N 名等权持有，每 10 根 K 线换仓一次并计入换手，同期等权买入持有作为基准。读四个数字：累计收益、年化收益、夏普比率、最大回撤，且基准曲线永远与策略曲线同图。"),
      p("一个 IC = 0.03 的因子在 Top-5 组合里可能跑不赢基准：换手成本、集中度和择时都在吃收益。这正是为什么网站不把 IC 当作终点。"),
      h2("9. 库建好之后的三件事（1 分钟）"),
      bullet([b("多因子合成 "), r("：把多个低相关因子按 rank 等权或按 IC 加权叠加成复合信号，再跑同一条组合回测。")]),
      bullet([b("衰减监控 "), r("：把 IC 序列按近 60 / 120 / 全样本切段，近端明显低于远端就该降权或下线。")]),
      bullet([b("跨市场移植 "), r("：美股上挖到的因子直接在加密样本上重算 IC；两边都成立更像真规律，只在一边成立可能是样本特性。")]),
      h2("10. 诚实原则（1 分钟）"),
      p("机器挖矿最大的风险是骗自己。网站在设计上把五条原则写成了硬约束："),
      bullet("留出集只考一次；样本内可以反复迭代，留出集永远不进反馈。"),
      bullet("允许空手而归；一轮下来零因子被接受是合法结果，界面解释原因而不是凑数。"),
      bullet("基准永远在图上；任何净值曲线旁边都有买入持有。"),
      bullet("记录每一次拒绝；被拒理由进入教训库。"),
      bullet("上线后继续考；模拟持仓把上线前后同一规则的夏普摆在一起，给出「衰减 / 保持 / 增强」判定。"),
      p([b("三个常见坑"), r("：前视偏差（用了未来数据）、幸存者偏差（样本只剩活下来的公司）、多重比较（试 1000 个总有 50 个「显著」）。Harvey、Liu 与 Zhu 建议把因子研究的 t 统计量门槛提高到 3.0，正是针对第三个坑。")]),
      h2("11. 总结（1 分钟）"),
      p("三句话带走：因子 = 表达式 + 横截面 IC；搜索靠 LLM 循环或遗传进化，录取靠留出集；IC 只是门票，组合回测和上线后的衰减才是成绩。"),
      new Paragraph({ children: [new PageBreak()] }),
      h1("三、课堂演示步骤（约 5 分钟，可穿插在第 5–9 节）"),
      p("打开网站，进入「因子挖掘」板块："),
      bullet("选择市场（美股 / 数字货币）与门槛档，第一次建议 standard。", "steps"),
      bullet("引擎选 LLM：观察每一轮的接受与拒绝理由，指出「教训」如何进入下一轮；或选 GP：观察名人堂逐代刷新与冠军净值曲线。", "steps"),
      bullet("对一个被接受的因子点「组合回测」，读累计收益、年化、夏普、最大回撤，并与基准比较。", "steps"),
      bullet("点「检查」：看衰减曲线与跨市场移植结果。", "steps"),
      bullet("点「上线」把它放进模拟持仓，一周后回来看「回测期 vs 上线后」对照与衰减判定。", "steps"),
      note("演示前提示：LLM 引擎按 IP 限流（每日 5 次挖掘、20 次进化），课堂上建议提前跑好一轮结果作为备份截图。"),
      h1("四、术语表"),
      table(["术语", "解释"], [
        ["因子（Factor / Alpha）", "对每个标的每天可计算的数值信号，与未来收益的横截面排序相关"],
        ["横截面", "同一时间点上对所有标的进行比较"],
        ["IC（信息系数）", "因子值排名与未来收益排名的 Spearman 相关，逐日计算"],
        ["ICIR", "IC 序列均值除以标准差，衡量稳定性"],
        ["留出集（Holdout）", "时间上最后 20% 的样本，只用于确认，不参与任何反馈"],
        ["DSL", "受限的领域特定语言；这里指因子表达式语法"],
        ["循环工程（Loop Engineering）", "让评估结果结构化地进入下一轮生成的迭代方法"],
        ["遗传编程（GP）", "以语法树为个体、用交叉与变异搜索程序空间的进化算法"],
        ["名人堂（Hall of Fame）", "进化过程中保留的最优且互不冗余的个体集合"],
        ["再平衡", "按固定周期重新按因子排序并调整持仓"],
        ["最大回撤", "净值从峰值到谷底的最大跌幅"],
        ["衰减", "因子预测力随时间下降，通常因为被市场学走"],
      ], [3000, 6440]),
      h1("五、讨论题与作业"),
      bullet("如果一个因子样本内 IC = 0.04、留出 IC = 0.01，你会接受它吗？给出两条支持和两条反对的理由。", "steps2"),
      bullet("为什么「必须含变换」这条规则会把裸 volume 拒之门外？规模效应难道不是真实存在的吗？", "steps2"),
      bullet("遗传算法的简约惩罚系数 0.0015 若改成 0.01，你预期种群会发生什么变化？", "steps2"),
      bullet("作业：用 loose 档在数字货币市场跑一轮 GP 进化，把发现的因子移植到美股，记录 IC 的变化并用一段话解释。", "steps2"),
      h1("六、延伸阅读"),
      bullet("Kakushadze, Z. (2016). 101 Formulaic Alphas. —— 表达式因子的经典目录，DSL 算子的直接来源。"),
      bullet("Harvey, C., Liu, Y., & Zhu, H. (2016). … and the Cross-Section of Expected Returns. —— 多重比较问题与 t = 3.0 门槛。"),
      bullet("Gu, S., Kelly, B., & Xiu, D. (2020). Empirical Asset Pricing via Machine Learning. —— 机器学习因子研究的方法论基线。"),
      bullet("Koza, J. R. (1992). Genetic Programming. —— 语法树进化的源头。"),
      bullet("近年的 LLM 因子挖掘工作（Chain-of-Alpha、AlphaAgent 等）：网站的循环工程与复杂度正则直接借鉴其思路。"),
    ],
  }],
});
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync("因子挖掘-15分钟讲义.docx", buf); console.log("wrote docx"); });
