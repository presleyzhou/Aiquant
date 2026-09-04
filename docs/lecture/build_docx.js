const fs = require("fs");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, LevelFormat, PageBreak, BorderStyle } = require("docx");

const F = "Microsoft YaHei";
const NAVY = "13213A", CYAN = "0FA8C9", GREY = "6B7A90", VIOLET = "5B4BC4";
const R = (t, o = {}) => new TextRun({ text: t, font: F, size: 21, color: NAVY, ...o });
const B = (t) => R(t, { bold: true });
const I = (t) => R(t, { italics: true });
const P = (children, o = {}) => new Paragraph({ spacing: { after: 140, line: 340 }, ...o, children: Array.isArray(children) ? children : [R(children)] });
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 380, after: 140 }, children: [new TextRun({ text: t, font: F, size: 30, bold: true, color: NAVY })] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 260, after: 100 }, children: [new TextRun({ text: t, font: F, size: 24, bold: true, color: CYAN })] });
const UL = (children, ref = "bullets") => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 90, line: 320 }, children: Array.isArray(children) ? children : [R(children)] });
const CODE = (t) => new Paragraph({ spacing: { after: 140 }, shading: { type: ShadingType.CLEAR, fill: "EEF6FA", color: "auto" }, indent: { left: 360, right: 360 }, children: t.split("\n").map((line, i) => new TextRun({ text: line, font: "Courier New", size: 19, color: NAVY, break: i > 0 ? 1 : 0 })) });
const FORMULA = (t, label) => new Paragraph({ spacing: { after: 140, before: 60 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: t, font: "Cambria Math", size: 22, color: NAVY }), ...(label ? [new TextRun({ text: `　　(${label})`, font: F, size: 19, color: GREY })] : [])] });
const DEF = (term, body) => new Paragraph({ spacing: { after: 140, line: 340 }, indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: CYAN, space: 8 } }, children: [new TextRun({ text: `定义（${term}）　`, font: F, size: 21, bold: true, color: CYAN }), R(body)] });
const KEY = (t) => new Paragraph({ spacing: { after: 140, line: 340 }, indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: VIOLET, space: 8 } }, children: [new TextRun({ text: "要点　", font: F, size: 21, bold: true, color: VIOLET }), R(t)] });
const NOTE = (t) => P([new TextRun({ text: t, font: F, size: 19, italics: true, color: GREY })]);
const GAP = () => new Paragraph({ spacing: { after: 40 }, children: [] });

function table(headers, rows, widths) {
  const total = widths.reduce((a, c) => a + c, 0);
  const cell = (t, head, w) => new TableCell({ width: { size: w, type: WidthType.DXA }, shading: head ? { type: ShadingType.CLEAR, fill: "13213A", color: "auto" } : undefined, margins: { top: 70, bottom: 70, left: 110, right: 110 }, children: [new Paragraph({ spacing: { after: 0, line: 300 }, children: [new TextRun({ text: t, font: F, size: 19, bold: head, color: head ? "FFFFFF" : NAVY })] })] });
  return new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: widths, rows: [new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, true, widths[i])) }), ...rows.map((row) => new TableRow({ children: row.map((c, i) => cell(c, false, widths[i])) }))] });
}
const numbering = (ref, fmt) => ({ reference: ref, levels: [{ level: 0, format: fmt, text: fmt === LevelFormat.BULLET ? "•" : "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] });

const doc = new Document({
  styles: { default: { document: { run: { font: F, size: 21 } } } },
  numbering: { config: [numbering("bullets", LevelFormat.BULLET), numbering("steps", LevelFormat.DECIMAL), numbering("q", LevelFormat.DECIMAL), numbering("goals", LevelFormat.DECIMAL), numbering("loop", LevelFormat.DECIMAL)] },
  sections: [{
    properties: { page: { margin: { top: 1300, bottom: 1300, left: 1400, right: 1400 } } },
    children: [
      new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "因子挖掘：搜索、验证与闭环迭代", font: F, size: 40, bold: true, color: NAVY })] }),
      new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "15 分钟讲义 · 基于 AIQUANT TERMINAL 因子挖掘模块的实现", font: F, size: 24, color: CYAN })] }),
      NOTE("面向具备基础统计概念的听众。本讲义按「定义 → 方法 → 验证 → 工程化」的顺序组织，第 4 节系统阐述 Loop Engineering（闭环迭代生成）在因子挖掘中的应用。所有阈值与公式均取自平台当前实现。"),
      GAP(),

      H1("摘要"),
      P("因子挖掘的目标，是在给定的表达式空间中寻找对未来收益具有稳定横截面预测能力的信号。本讲围绕三个问题展开：如何表示和评价一个因子；如何在不引入过拟合的前提下自动化地搜索因子；以及如何把搜索结果转化为可跟踪、可淘汰的投资组合。方法层面重点比较两类搜索范式——基于大语言模型的闭环迭代生成（Loop Engineering）与遗传编程——并说明二者共享的同一套评估协议。"),
      H2("学习目标"),
      UL("能准确定义因子、信息系数（IC）与 ICIR，并解释横截面预测与时间序列预测的区别。", "goals"),
      UL("能描述时间序列留出验证协议，说明留出集为何必须与反馈通道隔离。", "goals"),
      UL("能用「状态—生成—评估—更新」框架描述 Loop Engineering，并指出其失效模式与对策。", "goals"),
      UL("能解释为什么 IC 是必要而非充分条件，以及组合回测与前向跟踪各自回答什么问题。", "goals"),

      H1("1　问题定义"),
      H2("1.1　因子与横截面预测"),
      DEF("因子", "给定标的集合 U 与交易日序列 T，因子是一个映射 f：U × T → ℝ，即在每个交易日 t 对每个标的 i 给出一个实数 f(i, t)。因子值本身没有单位意义，其信息完全体现在同一交易日内的相对排序上。"),
      P("因子研究关心的是横截面问题：在第 t 日，f(·, t) 的排序是否与未来 h 日收益 r(·, t+h) 的排序一致。这与时间序列预测（预测某一标的自身的未来走势）是不同的问题，评价方法也不同。"),
      CODE("rank(delta(close, 20))\n# 20 日价格变化的横截面排名：最基本的动量因子"),
      H2("1.2　评价指标"),
      DEF("IC", "第 t 日的信息系数 IC_t 为因子值与未来 h 日收益在横截面上的 Spearman 秩相关系数。"),
      FORMULA("IC_t = ρ_Spearman( f(·, t), r(·, t+h) )", "1"),
      FORMULA("IC = mean_t(IC_t)　　ICIR = mean_t(IC_t) / std_t(IC_t)", "2"),
      P("IC 的均值刻画预测强度，ICIR 刻画预测的稳定性。两者缺一不可：高 IC 低 ICIR 的因子往往由少数极端交易日驱动，样本外表现不可靠。经验上，日频美股横截面上 |IC| ≥ 0.02 已属可用，≥ 0.05 应首先怀疑前视偏差。"),
      H2("1.3　数据与参数"),
      table(["项目", "美股", "数字货币"], [
        ["标的数", "60", "24"],
        ["交易日历", "工作日", "全年 7 × 24"],
        ["默认预测期 h", "10 个交易日", "10 个交易日"],
        ["年化因子", "252", "365"],
        ["数据质量过滤", "单日收益超过 400% 的记录视为数据错误并剔除", "同左"],
      ], [2400, 3500, 3540]),

      H1("2　因子表示：表达式 DSL"),
      P("平台把因子限定为一门受限领域特定语言（DSL）的合法表达式。统一的表示使得不同搜索方法（LLM、遗传编程、人工）产出的候选可以在同一评估协议下比较、去重与审计。"),
      H2("2.1　算子集合"),
      table(["类别", "算子", "说明"], [
        ["原始字段", "open high low close volume", "唯一输入"],
        ["时序算子", "ts_mean ts_std ts_sum ts_min ts_max ts_rank delay delta ts_corr", "沿时间轴滚动，窗口 w ∈ [1, 120]"],
        ["横截面算子", "rank zscore", "在同一交易日内对所有标的标准化"],
        ["逐元素算子", "sign abs log sqrt neg，+ − × ÷", "无状态变换"],
      ], [1900, 4400, 3140]),
      H2("2.2　约束"),
      UL([B("规模约束："), R("长度 ≤ 240 字符，语法树深度 ≤ 10，节点数 ≤ 24。")]),
      UL([B("有效性约束："), R("因子值全为 NaN 或在横截面上为常数的表达式（如 close/close）在评估前拒绝。")]),
      UL([B("结构约束："), R("至少包含一个时序或横截面算子；裸 volume、裸 close 等规模代理不视为因子。")]),
      UL([B("安全约束："), R("手写递归下降解析器，不使用 eval；机器生成的字符串从不直接执行。")]),
      KEY("节点数上限同时是正则化手段：表达式越复杂，在样本内拟合噪声的自由度越大。AlphaAgent 等工作把复杂度作为显式惩罚项，平台采用硬上限加进化过程中的简约惩罚两种方式。"),

      H1("3　评估协议"),
      H2("3.1　流水线"),
      P("每个候选因子经过同一条确定性流水线："),
      UL("解析与约束校验。", "steps"),
      UL("在全样本面板上计算 f(i, t)。", "steps"),
      UL("逐日计算 IC_t，得到 IC 序列。", "steps"),
      UL("按时间切分：前 80% 为样本内，后 20% 为留出集。", "steps"),
      UL("在样本内计算 IC、ICIR，判断是否达到门槛。", "steps"),
      UL("在留出集计算 IC，检验符号一致性与强度。", "steps"),
      UL("与因子库中已接受因子计算因子值相关系数，检验冗余。", "steps"),
      H2("3.2　接受准则"),
      P("记样本内门槛为 (θ_IC, θ_ICIR)。候选被接受当且仅当同时满足："),
      FORMULA("|IC_in| ≥ θ_IC，　|ICIR_in| ≥ θ_ICIR", "3"),
      FORMULA("sign(IC_out) = sign(IC_in)，　|IC_out| ≥ θ_IC / 2", "4"),
      FORMULA("max_{z ∈ Z} |corr( f, z )| ≤ 0.7　（Z 为已接受因子集合）", "5"),
      P("式 (4) 是留出集确认：方向必须一致，强度允许衰减但不得低于门槛的一半。式 (5) 是冗余约束：与库中任一因子的因子值相关超过 0.7 即拒绝，无论其 IC 多高。"),
      H2("3.3　门槛分档"),
      table(["档位", "θ_IC", "θ_ICIR", "适用场景"], [
        ["strict", "0.020", "0.25", "研究级要求，产出少而精"],
        ["standard", "0.015", "0.15", "默认档；美股日频的合理水位"],
        ["loose", "0.010", "0.08", "横截面窄、噪声大的市场（如 24 个币的加密样本）"],
      ], [1700, 1500, 1700, 4540]),
      KEY("门槛应与数据的信噪比匹配，而不是一味从严。式 (4) 的留出集确认对三档一致生效，放宽的只是样本内门槛。"),
      H2("3.4　为什么用时间序列留出而非交叉验证"),
      P("金融面板数据具有时间顺序与序列相关性。随机 K 折切分会让训练折包含验证折之后的信息，造成前视泄漏。按时间一次性切分、留出集只使用一次，是最保守也最难被搜索过程「学习」的验证方式。代价是统计功效有限，因此平台把留出集设为确认而非筛选：它否决候选，但不参与排序。"),

      H1("4　Loop Engineering：闭环迭代生成"),
      H2("4.1　定义与动机"),
      DEF("Loop Engineering", "一种迭代式生成方法：生成器（此处为大语言模型）每一轮的输入不仅包含任务目标，还包含由外部评估器对上一轮输出给出的结构化反馈——接受集合、拒绝原因的归纳（教训）以及探索方向。迭代的对象是生成器的上下文，而不是生成器的参数。"),
      P("单次提示的局限是明确的。模型缺乏对当前数据的任何经验知识：它不知道哪些方向已被因子库覆盖、哪类表达式在该样本上系统性地不成立、自己上一次犯了什么语法错误。这些信息只能来自评估，而只有把评估结果送回生成端，模型的输出分布才会发生改变。Chain-of-Alpha 等工作把这一思路系统化：评估器充当「教练」，模型的角色是在反馈约束下提出新假设。"),
      H2("4.2　形式化描述"),
      P("记第 k 轮的状态为 S_k = (Z_k, L_k, D_k)，其中 Z_k 为已接受因子集合，L_k 为教训集合，D_k 为本轮探索方向。一轮迭代由四个映射构成："),
      UL([B("生成　"), R("C_k = G(目标, S_k)：模型输出候选表达式集合 C_k。")], "loop"),
      UL([B("评估　"), R("R_k = E(C_k, Z_k)：评估器对每个候选给出接受 / 拒绝及原因（语法、有效性、样本内、留出、冗余、复杂度）。E 是确定性代码，不含模型判断。")], "loop"),
      UL([B("反思　"), R("ΔL = Reflect(R_k)：把拒绝原因归纳为可迁移的一句话教训；把接受的候选并入 Z_{k+1}。")], "loop"),
      UL([B("更新　"), R("S_{k+1} = (Z_k ∪ Accepted_k, Dedup(L_k ∪ ΔL), D_{k+1})：组装下一轮的上下文。")], "loop"),
      KEY("评估器 E 必须独立于生成器 G。成绩由确定性计算给出，模型不参与对自身输出的打分，这是闭环可信的前提。"),
      H2("4.3　反馈通道设计：信息隔离原则"),
      table(["信息", "是否进入 G 的下一轮输入", "理由"], [
        ["已接受因子的表达式与样本内 IC", "是", "避免重复发明；给出方向参照"],
        ["被拒候选的一句话原因", "是", "避免重复犯错"],
        ["冗余拒绝时与哪个库内因子相关", "是", "引导离开已覆盖方向"],
        ["留出集是否通过", "是（仅二值）", "让模型知道方向不通"],
        ["留出集的 IC 数值", "否", "任何可用于微调的留出信息都会把留出集变成第二个样本内"],
        ["逐日 IC 序列", "否", "同上，且会诱导对特定时段拟合"],
      ], [3600, 2200, 3640]),
      P("这条原则决定了闭环方法能否保持样本外有效性。模型可以知道「这条路不通」，但不能获得「往哪个方向微调就能通过」的梯度信息。"),
      H2("4.4　迭代示例（三轮）"),
      P("以下示例取自美股、h = 10、standard 档的一次典型运行，数值为示意。"),
      table(["轮次", "候选（节选）", "评估结果", "写入教训 L"], [
        ["1", "rank(delta(close,20))", "IC_in 0.024，IC_out 0.019 → 接受", "—"],
        ["1", "rank(ts_mean(volume,500))", "窗口 500 > 120 → 语法拒绝", "窗口必须在 [1,120]"],
        ["1", "rank(close/delay(close,20))", "与候选 1 相关 0.99 → 冗余拒绝", "close/delay(close,n) 与 delta(close,n) 为同一信号"],
        ["1", "rank(ts_std(close,10))", "IC_in 0.021，IC_out −0.003 → 留出拒绝", "短窗口波动率单独使用在本样本留出不成立"],
        ["1", "rank(ts_corr(close,volume,20))", "IC_in 0.016，IC_out 0.011 → 接受", "—"],
        ["2", "量价背离、成交量相对变化、区间位置类表达式", "1 接受，2 因与 ts_corr 族相关 0.8 拒绝", "ts_corr(close,volume) 族已覆盖，转向 volume 自身的时序变化"],
        ["3", "区间位置 × 成交量相对变化等组合表达式", "0 接受", "两条新增；零接受为合法结果"],
      ], [700, 3000, 3000, 2740]),
      P("三轮之间可观察到两点变化。第一，错误类型逐轮消失：第二轮不再出现窗口越界与动量变体。第二，探索方向发生迁移：从动量到量价关系再到组合表达式，这一迁移由 D_k 与 L_k 共同驱动，而非模型自发。"),
      H2("4.5　失效模式与对策"),
      table(["失效模式", "机制", "平台对策"], [
        ["模式坍缩", "模型在已成功方向上做局部变体，候选相关性逐轮上升", "式 (5) 冗余约束；D_k 显式要求新方向"],
        ["上下文膨胀", "教训逐轮累加，提示词变长，早期教训被稀释", "教训去重，保留有限条数，相似教训合并"],
        ["样本内过拟合", "反复接触样本内成绩，候选向历史巧合收敛", "式 (4) 留出确认一票否决；留出数值不进反馈"],
        ["产出压力", "为「有结果」而降低门槛", "允许零接受；界面解释原因而不调整门槛"],
        ["复杂度漂移", "长表达式更易拟合样本内", "节点数 ≤ 24；结构约束"],
      ], [2000, 3800, 3640]),
      H2("4.6　跨会话记忆"),
      P("Z 与 L 在本地持久化。新会话从上次的状态继续，被拒方向不会被重新探索，已接受因子成为后续冗余检验的参照。闭环因此不仅在一次运行内成立，也跨运行成立。平台对 LLM 引擎按客户端限流（每日 5 次挖掘），课堂演示建议提前运行并保留结果。"),

      H1("5　对照方法：遗传编程"),
      H2("5.1　表示与算子"),
      P("遗传编程（GP）把表达式视为语法树，在同一 DSL 空间内以随机初始化、锦标赛选择、子树交叉与变异进行搜索。化简步骤消除 ts_min(ts_min(x)) 一类的冗余嵌套，控制膨胀。每代保留 8 个最优且互不冗余的个体构成名人堂（Hall of Fame）。"),
      H2("5.2　适应度函数"),
      FORMULA("fit = |IC| · (0.6 + 0.4 · min(1, |ICIR| / 0.5)) − 0.02 · (1 − stability) − 0.0015 · nodes", "6"),
      FORMULA("若 max_{z ∈ HOF} |corr(f, z)| > 0.7，则 fit ← 0.5 · fit", "7"),
      P("式 (6) 中 |IC| 为主项，ICIR 提供稳定性加成，节点数项为简约惩罚。式 (7) 是生态位保护：与名人堂成员高度相关的个体适应度减半，迫使种群探索不同区域。产出同样经过第 3 节的评估协议后才进入因子库。"),
      H2("5.3　两种范式的比较"),
      table(["维度", "Loop Engineering（LLM）", "遗传编程（GP）"], [
        ["候选来源", "语言模型，带金融先验", "随机组合与变异，无先验"],
        ["反馈形式", "结构化文本进入上下文", "标量适应度驱动选择"],
        ["可解释性", "高：候选附带假设，可对话", "中：需化简与复杂度约束"],
        ["成本", "每轮调用模型，受限流约束", "纯计算，易并行"],
        ["典型风险", "在熟悉方向打转", "表达式膨胀、语义空洞"],
        ["评估协议", "共用第 3 节流水线与门槛", "同左"],
      ], [1800, 3820, 3820]),

      H1("6　从因子到组合"),
      H2("6.1　组合构建"),
      P("组合回测采用最简单、最不易被参数调优污染的规则：每 10 根 K 线为一个再平衡周期；在再平衡日按因子值排序（可反向），取前 N 名等权持有；换仓计入手续费与滑点；以同期等权买入持有作为基准。"),
      H2("6.2　绩效指标"),
      FORMULA("CAGR = (V_T / V_0)^{252/T} − 1　　Sharpe = mean(r_t) / std(r_t) · √252", "8"),
      FORMULA("MDD = min_t ( V_t / max_{s ≤ t} V_s − 1 )", "9"),
      P("四项指标——累计收益、年化收益、夏普比率、最大回撤——始终与基准并列展示。IC 是必要条件而非充分条件：一个 IC = 0.03 的因子在 Top-5 组合中可能因换手成本、集中度与再平衡时点而落后基准。"),

      H1("7　上线后监控"),
      H2("7.1　衰减检测"),
      P("将 IC 序列按最近 60 日、120 日与全样本分段比较。近端 IC 显著低于远端，提示因子被市场消化。平台在「检查」功能中给出分段 IC 与健康状态。"),
      H2("7.2　跨市场迁移"),
      P("在另一市场（美股 ↔ 加密）上重算同一表达式的 IC。两侧同号且达标，因子更可能反映一般性规律；仅一侧成立，则更可能是样本特性。"),
      H2("7.3　前向跟踪与衰减判定"),
      P("因子或策略被「上线」到模拟持仓后，从上线日起按规则重放净值，上线后的每一根 K 线对规则而言均为样本外。平台把上线前（回测期）与上线后同一规则的夏普比率并列，判定规则为："),
      table(["判定", "条件"], [
        ["数据不足", "回测期 < 60 根或上线后 < 20 根 K 线"],
        ["衰减", "上线后夏普 < 回测期夏普 − 0.5，且上线后超额收益 < 0"],
        ["增强", "上线后夏普 > 回测期夏普 + 0.3"],
        ["保持", "其余情形"],
      ], [2200, 7240]),

      H1("8　方法论原则"),
      UL([B("留出集单次使用：")," 样本内可反复迭代，留出集只做确认，不进入任何反馈。"]),
      UL([B("允许空集：")," 一轮零接受是合法结论，反映数据在该方向缺乏可靠信号。"]),
      UL([B("基准并列：")," 任何净值曲线与买入持有同图展示，不单独呈现绝对收益。"]),
      UL([B("拒绝可追溯：")," 每次拒绝的原因进入教训库，供后续迭代与审阅。"]),
      UL([B("持续验证：")," 上线后继续以样本外数据评价，并给出明确的衰减判定。"]),
      P([B("三类常见偏差："), R("前视偏差（使用了决策时不可得的信息）、幸存者偏差（样本只含存续至今的标的）、多重比较（大量尝试下的偶然显著）。Harvey、Liu 与 Zhu（2016）建议将因子研究的 t 统计量门槛提高至 3.0，正是针对第三类。留出集确认与冗余约束是平台对该问题的工程化回应。")]),

      H1("9　总结"),
      UL("因子是横截面排序信号；IC 与 ICIR 分别度量其强度与稳定性。"),
      UL("Loop Engineering 通过「生成—评估—反思—更新」的闭环改变生成器的上下文，其有效性依赖评估器独立与留出集隔离两个条件。"),
      UL("遗传编程提供无先验的对照搜索；两种范式共用同一评估协议。"),
      UL("IC 是门票，组合回测是成绩单，前向跟踪是最终检验。"),

      new Paragraph({ children: [new PageBreak()] }),
      H1("附录 A　时间安排"),
      table(["时间", "内容", "幻灯片", "对应章节"], [
        ["0:00–1:00", "问题定义与学习目标", "1", "摘要、1.1"],
        ["1:00–3:00", "IC / ICIR 与数据", "2", "1.2、1.3"],
        ["3:00–4:00", "表达式 DSL 与约束", "3", "2"],
        ["4:00–6:00", "评估协议、留出确认、门槛分档", "4–5", "3"],
        ["6:00–10:00", "Loop Engineering", "6", "4"],
        ["10:00–12:00", "遗传编程与比较", "7–8", "5"],
        ["12:00–13:30", "组合构建与绩效指标", "9", "6"],
        ["13:30–14:30", "上线后监控与方法论原则", "10–11", "7、8"],
        ["14:30–15:00", "总结", "12", "9"],
      ], [1400, 3400, 1200, 3440]),
      GAP(),
      H1("附录 B　课堂演示步骤"),
      UL("进入「因子挖掘」：市场选美股，门槛 standard，引擎 LLM，开始运行。", "steps"),
      UL("逐条说明第一轮的接受与拒绝原因，重点指出冗余拒绝与留出拒绝。", "steps"),
      UL("第二轮开始时展示提示词摘要，确认教训已进入上下文。", "steps"),
      UL("切换 GP 引擎，观察名人堂逐代更新与表达式长度受控。", "steps"),
      UL("对已接受因子依次执行「组合回测」「检查」「上线」，读取四项指标、分段 IC、迁移结果。", "steps"),
      H1("附录 C　术语表"),
      table(["术语", "定义"], [
        ["因子", "映射 f：U × T → ℝ，在每个交易日对每个标的给出一个实数"],
        ["横截面", "同一交易日内对所有标的的比较"],
        ["IC / ICIR", "逐日 Spearman 秩相关的均值 / 均值与标准差之比"],
        ["样本内 / 留出集", "按时间划分的前 80% / 后 20%；后者仅用于确认"],
        ["Loop Engineering", "以评估反馈迭代更新生成器上下文的闭环生成方法"],
        ["教训（lessons）", "对拒绝原因的可迁移归纳，作为下一轮输入的一部分"],
        ["冗余", "与已接受因子的因子值相关系数超过 0.7"],
        ["遗传编程", "以语法树为个体、以选择/交叉/变异为算子的进化搜索"],
        ["名人堂", "进化过程中保留的最优且互不冗余的个体集合"],
        ["再平衡", "按固定周期依因子值重新构建持仓"],
        ["最大回撤", "净值相对历史峰值的最大跌幅"],
        ["衰减", "因子预测能力随时间下降"],
      ], [2600, 6840]),
      H1("附录 D　思考题"),
      UL("一个候选样本内 IC = 0.04、留出 IC = 0.01（同号），按 standard 档是否接受？若把 h 从 10 改为 5，你预期两个数值如何变化？", "q"),
      UL("若把留出集 IC 的数值也送入下一轮提示词，闭环会在多少轮内出现样本外退化？请从 4.3 节的信息隔离原则出发论证。", "q"),
      UL("式 (6) 中简约惩罚系数从 0.0015 提高到 0.01，种群的平均节点数与最优适应度将如何变化？", "q"),
      UL("为什么裸 volume 不被视为因子，而 rank(delta(volume, 5)) 可以？规模效应本身是否是有效因子？", "q"),
      H1("附录 E　参考文献"),
      UL("Kakushadze, Z. (2016). 101 Formulaic Alphas. Wilmott Magazine."),
      UL("Harvey, C. R., Liu, Y., & Zhu, H. (2016). … and the Cross-Section of Expected Returns. Review of Financial Studies."),
      UL("Gu, S., Kelly, B., & Xiu, D. (2020). Empirical Asset Pricing via Machine Learning. Review of Financial Studies."),
      UL("Koza, J. R. (1992). Genetic Programming: On the Programming of Computers by Means of Natural Selection. MIT Press."),
      UL("近年基于大语言模型的因子挖掘工作（Chain-of-Alpha、AlphaAgent 等）：闭环反馈与复杂度正则的直接来源。"),
    ],
  }],
});
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync("因子挖掘-15分钟讲义.docx", buf); console.log("wrote docx", buf.length); });
