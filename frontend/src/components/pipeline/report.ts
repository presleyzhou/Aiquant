import type { PipelineMemoRequest, PipelineResult } from "../../api";
import type { Lang, MsgKey } from "../../i18n";
import { WARNING_KEYS } from "./constants";
import { fmtAum, numOpt, pct, pct2Opt, prob, ratio, signed1, signed2Opt, signed3 } from "./format";

export type Translate = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** V4 Markdown report: the same numbers the page shows, in the current UI
 * language, laid out for a chat window or a notebook. No curves. */
export function markdownReport(
  r: PipelineResult,
  t: Translate,
  names: { market: string; scheme: string; weighting: string; sector: (symbol: string, group?: string) => string | undefined },
): string {
  const bt = r.backtest;
  const st = bt.stats;
  const b = st.benchmark;
  const o = bt.overfitting;
  const dash = "—";
  const pc = (v: number | null | undefined) => (v === null || v === undefined ? dash : pct(v));
  const p1 = (v: number | null | undefined) => (v === null || v === undefined ? dash : `${v.toFixed(1)}%`);
  const esc = (v: string) => v.replaceAll("|", "\\|");
  const row = (cells: Array<string | number>) => `| ${cells.map((c) => esc(String(c))).join(" | ")} |`;
  const table = (head: string[], rows: Array<Array<string | number>>) =>
    [row(head), `|${head.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`, ...rows.map(row)].join("\n");
  const out: string[] = [];

  out.push(`# ${t("pl.md.title")}`);
  out.push("");
  out.push(t("pl.md.meta", { m: names.market, s: names.scheme, n: r.signal.components.length, w: names.weighting }));
  out.push(t("pl.md.span", { from: bt.span.from, to: bt.span.to, k: r.universe.symbols, d: new Date().toISOString().slice(0, 10) }));
  out.push("");

  out.push(`## ${t("pl.md.factors")}`);
  for (const c of r.signal.components) {
    const inv = c.invert ? ` · ${t("fl.bt.inverted")}` : "";
    const active = c.active_pct !== undefined && c.active_pct < 100 ? ` · ${t("pl.sig.active", { v: c.active_pct.toFixed(0) })}` : "";
    out.push(
      `- \`${c.expression}\`${inv} — ${t("pl.md.factorRow", {
        w: (c.weight * 100).toFixed(0), is: signed3(c.is_ic), oos: signed3(c.oos_ic), s: c.standalone_sharpe.toFixed(2),
      })}${active}`,
    );
  }
  out.push("");

  out.push(`## ${t("pl.md.headline")}`);
  const headRows: Array<Array<string | number>> = [
    [t("bt.totalReturn"), pct(st.total_return_pct), pct(b.total_return_pct)],
    [t("pl.bt.excess"), pct(st.excess_pct), dash],
    [t("bt.cagr"), pc(st.cagr_pct), pc(b.cagr_pct)],
    [t("bt.sharpe"), st.sharpe.toFixed(2), b.sharpe.toFixed(2)],
    [t("bt.sortino"), st.sortino.toFixed(2), dash],
    [t("pl.bt.calmar"), st.calmar.toFixed(2), dash],
    [t("bt.maxdd"), pct(st.max_drawdown_pct), pct(b.max_drawdown_pct)],
    [t("pl.bt.vol"), p1(st.ann_vol_pct), p1(b.ann_vol_pct)],
    [t("bt.winrate"), p1(st.win_rate_pct), dash],
  ];
  if (st.rolling_6m_beat_pct !== undefined) headRows.push([t("pl.bt.rolling"), p1(st.rolling_6m_beat_pct), dash]);
  out.push(table([t("pp.cmp.metric"), t("pl.bt.strategy"), t("fl.bt.bench")], headRows));
  out.push("");

  out.push(`## ${t("pl.md.split")}`);
  out.push(
    table(
      [t("pp.cmp.metric"), `${t("lab.tbl.insample")} ${bt.in_sample.from} → ${bt.in_sample.to}`, `${t("pl.bt.holdout")} ${bt.holdout.from} → ${bt.holdout.to}`],
      [
        [t("bt.totalReturn"), pct(bt.in_sample.total_return_pct), pct(bt.holdout.total_return_pct)],
        [t("bt.sharpe"), bt.in_sample.sharpe.toFixed(2), bt.holdout.sharpe.toFixed(2)],
        [t("bt.maxdd"), pct(bt.in_sample.max_drawdown_pct), pct(bt.holdout.max_drawdown_pct)],
        [t("pl.bt.excess"), pct(bt.in_sample.excess_pct), pct(bt.holdout.excess_pct)],
      ],
    ),
  );
  out.push("");

  if (o) {
    out.push(`## ${t("pl.md.ofit")}`);
    const mintrl =
      o.min_track_record_days === undefined
        ? dash
        : o.min_track_record_days === null
          ? t("pl.bt.ofit.mintrlNone")
          : t("pl.bt.ofit.mintrlVal", { need: o.min_track_record_days, have: o.track_days ?? dash });
    out.push(
      t("pl.md.ofitLine", {
        psr: prob(o.psr), dsr: prob(o.dsr), t: numOpt(o.t_stat), h: (o.hlz_hurdle ?? 3).toFixed(1), mintrl, n: o.trials,
      }),
    );
    out.push("");
  }

  const sens = r.sensitivity;
  if (sens) {
    out.push(`## ${t("pl.md.sens", { tn: sens.top_n.join("/"), rb: sens.rebalance.join("/") })}`);
    out.push(t("pl.md.sensLine", { med: numOpt(sens.median_sharpe), min: numOpt(sens.min_sharpe), spike: signed2Opt(sens.spike) }));
    out.push("");
    out.push(
      table(
        [t("pl.bt.sens.corner"), ...sens.rebalance.map(String)],
        sens.top_n.map((n, i) => [
          n,
          ...sens.rebalance.map((rb, j) => {
            const c = sens.cells[i]?.[j];
            if (!c) return dash;
            const v = c.sharpe.toFixed(2);
            return n === r.portfolio.top_n && rb === r.portfolio.rebalance ? `**${v}**` : v;
          }),
        ]),
      ),
    );
    out.push("");
    out.push(`> ${t("pl.bt.sens.note")}`);
    out.push("");
  }

  const cap = r.capacity;
  if (cap) {
    out.push(`## ${t("pl.cap.title")}`);
    out.push(cap.breakeven_aum === null ? t("pl.cap.none") : t("pl.cap.headline", { v: fmtAum(cap.breakeven_aum) }));
    out.push("");
    out.push(
      table(
        [t("pl.cap.aum"), t("pl.cap.drag"), t("pl.cap.net"), t("pl.cap.part")],
        cap.aum_grid.map((aum, i) => [
          fmtAum(aum),
          pct2Opt(cap.impact_drag_pct_ann[i]),
          pc(cap.net_excess_pct_ann[i]),
          pct2Opt(cap.participation_pct[i]),
        ]),
      ),
    );
    out.push("");
    out.push(`> ${t("pl.cap.note")}`);
    out.push("");
  }

  out.push(`## ${t("pl.md.risk")}`);
  const risk = r.risk;
  const chips = [
    `β ${st.beta.toFixed(2)}`,
    `${t("pl.risk.te")} ${st.tracking_error_pct.toFixed(1)}%`,
    `IR ${st.information_ratio.toFixed(2)}`,
    `${t("pl.risk.corr")} ${risk.correlation_to_benchmark.toFixed(2)}`,
    t("pl.pf.effN", { n: risk.concentration.avg_effective_n.toFixed(1) }),
    t("pl.risk.cap", { v: risk.concentration.cap_binding_pct.toFixed(0) }),
    t("pl.pf.exposure", { v: r.portfolio.avg_exposure_pct.toFixed(0) }),
    t("pl.pf.annualTurnover", { v: (r.portfolio.annual_turnover_x ?? 0).toFixed(1) }),
  ];
  if (risk.capture) {
    chips.push(t("pl.risk.captureUp", { v: ratio(risk.capture.up), n: risk.capture.up_periods }));
    chips.push(t("pl.risk.captureDown", { v: ratio(risk.capture.down), n: risk.capture.down_periods }));
  }
  if (risk.cvar_95_pct !== undefined) chips.push(t("pl.risk.cvar", { v: numOpt(risk.cvar_95_pct) }));
  if (risk.attribution) {
    chips.push(t("pl.risk.attr.alloc", { v: signed1(risk.attribution.allocation_pct) }));
    chips.push(t("pl.risk.attr.sel", { v: signed1(risk.attribution.selection_pct) }));
  }
  out.push(chips.map((c) => `- ${c}`).join("\n"));
  out.push("");

  out.push(`## ${t("pl.md.weights", { d: r.target_weights.as_of, e: r.target_weights.exposure_pct.toFixed(0) })}`);
  const top = r.target_weights.weights.slice(0, 5);
  const withSector = top.some((w) => names.sector(w.symbol, w.group) !== undefined);
  out.push(
    table(
      ["#", t("pl.deploy.symbol"), ...(withSector ? [t("pl.deploy.sector")] : []), t("pl.deploy.weight")],
      top.map((w) => [
        w.score_rank,
        w.symbol,
        ...(withSector ? [names.sector(w.symbol, w.group) ?? dash] : []),
        `${w.weight_pct.toFixed(1)}%`,
      ]),
    ),
  );
  out.push("");

  out.push(`## ${t("pl.md.warnings")}`);
  out.push(
    r.warnings.length === 0
      ? t("pl.md.none")
      : r.warnings.map((w) => `- ⚠ ${WARNING_KEYS[w] ? t(WARNING_KEYS[w]) : t("pl.warn.generic", { code: w })}`).join("\n"),
  );
  out.push("");
  out.push(`_${t("pl.disclaimer")}_`);
  return out.join("\n");
}

/** Exactly the summary the page displays — never the curves — so the memo
 * cannot cite a number the user has not seen. Truncations per the contract. */
export function memoRequest(r: PipelineResult, lang: Lang): PipelineMemoRequest {
  return {
    spec: r.spec,
    universe: r.universe,
    signal: {
      weighting: r.signal.weighting,
      components: r.signal.components.map((c) => ({
        expression: c.expression,
        is_ic: c.is_ic,
        oos_ic: c.oos_ic,
        weight: c.weight,
        standalone_sharpe: c.standalone_sharpe,
      })),
      max_pair_corr: r.signal.max_pair_corr,
      ic_by_horizon: r.signal.ic_by_horizon,
      composite_is_ic: r.signal.composite_is_ic,
      composite_oos_ic: r.signal.composite_oos_ic,
      quantiles: r.signal.quantiles,
    },
    portfolio: r.portfolio,
    stats: r.backtest.stats,
    in_sample: r.backtest.in_sample,
    holdout: r.backtest.holdout,
    overfitting: r.backtest.overfitting,
    risk: {
      drawdowns: r.risk.drawdowns.slice(0, 3),
      contributors: r.risk.contributors.slice(0, 3),
      detractors: r.risk.detractors.slice(0, 3),
      concentration: r.risk.concentration,
      correlation_to_benchmark: r.risk.correlation_to_benchmark,
      capture: r.risk.capture,
      cvar_95_pct: r.risk.cvar_95_pct,
      bench_cvar_95_pct: r.risk.bench_cvar_95_pct,
      regimes: r.risk.regimes,
      attribution: r.risk.attribution
        ? {
            allocation_pct: r.risk.attribution.allocation_pct,
            selection_pct: r.risk.attribution.selection_pct,
            interaction_pct: r.risk.attribution.interaction_pct,
            groups: r.risk.attribution.groups.slice(0, 5),
          }
        : undefined,
    },
    warnings: r.warnings,
    lang,
  };
}
