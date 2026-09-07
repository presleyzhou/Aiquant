import type { PipelineOrders, PipelineResult, PipelineRunRequest } from "../../api";
import { WARNING_KEYS } from "./constants";
import type { Translate } from "./report";

/** V4-pipeline Excel export. SheetJS is ~400 kB, so it is loaded on first
 * click (`await import("xlsx")` → its own Vite chunk) and never on page load.
 * Every sheet is the same data the page shows; the curves are included here
 * because a spreadsheet, unlike the Markdown report, is where you re-plot. */

type Row = Record<string, string | number | boolean | null>;

async function loadXlsx() {
  return import("xlsx");
}

/** Vite/Rollup code-splits this; the type import keeps tsc honest without pulling the module in. */
type Xlsx = Awaited<ReturnType<typeof loadXlsx>>;

const dateOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const n2 = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const n4 = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10000) / 10000);

function sheet(XLSX: Xlsx, wb: ReturnType<Xlsx["utils"]["book_new"]>, name: string, rows: Row[]) {
  // Excel sheet names: ≤ 31 chars, no []:*?/\
  const safe = name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet";
  const ws = rows.length > 0 ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([["—"]]);
  XLSX.utils.book_append_sheet(wb, ws, safe);
}

export async function exportPipelineWorkbook(
  r: PipelineResult,
  t: Translate,
  names: { market: string; scheme: string; weighting: string; sector: (symbol: string, group?: string) => string | undefined },
): Promise<string> {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  const st = r.backtest.stats;
  const b = st.benchmark;
  const o = r.backtest.overfitting;
  const kv = (k: string, v: string | number | boolean | null | undefined): Row => ({ [t("pl.xl.key")]: k, [t("pl.xl.value")]: v === undefined ? null : v });

  // 概览: headline stats, split, overfitting, then the spec verbatim
  const overview: Row[] = [
    kv(t("fl.market"), names.market),
    kv(t("pl.pf.scheme"), names.scheme),
    kv(t("pl.sig.weighting"), names.weighting),
    kv(t("pl.uni.span"), `${r.backtest.span.from} → ${r.backtest.span.to}`),
    kv(t("pl.uni.covered"), r.universe.symbols),
    kv(t("pl.xl.cached"), r.cached === true),
    kv(t("bt.totalReturn"), n2(st.total_return_pct)),
    kv(`${t("bt.totalReturn")} · ${t("fl.bt.bench")}`, n2(b.total_return_pct)),
    kv(t("pl.bt.excess"), n2(st.excess_pct)),
    kv(t("bt.cagr"), n2(st.cagr_pct)),
    kv(t("bt.sharpe"), n2(st.sharpe)),
    kv(`${t("bt.sharpe")} · ${t("fl.bt.bench")}`, n2(b.sharpe)),
    kv(t("bt.sortino"), n2(st.sortino)),
    kv(t("pl.bt.calmar"), n2(st.calmar)),
    kv(t("bt.maxdd"), n2(st.max_drawdown_pct)),
    kv(t("pl.bt.vol"), n2(st.ann_vol_pct)),
    kv(t("bt.winrate"), n2(st.win_rate_pct)),
    kv(`${t("lab.tbl.insample")} ${t("bt.sharpe")}`, n2(r.backtest.in_sample.sharpe)),
    kv(`${t("pl.bt.holdout")} ${t("bt.sharpe")}`, n2(r.backtest.holdout.sharpe)),
    kv(`${t("pl.bt.holdout")} ${t("pl.bt.excess")}`, n2(r.backtest.holdout.excess_pct)),
    kv("PSR", n4(o?.psr)),
    kv("DSR", n4(o?.dsr)),
    kv(t("pl.bt.ofit.trials"), o?.trials ?? null),
    kv(t("pl.bt.ofit.tstat"), n2(o?.t_stat)),
    kv(t("pl.cmp.effN"), n2(r.portfolio.avg_effective_n)),
    kv(t("pl.xl.exposure"), n2(r.portfolio.avg_exposure_pct)),
    kv(t("pl.xl.netExposure"), n2(r.portfolio.avg_net_exposure_pct)),
    kv(t("pl.xl.annualTurnover"), n2(r.portfolio.annual_turnover_x)),
    kv(t("pl.xl.breakevenCost"), n2(r.portfolio.breakeven_cost_bps)),
    kv(t("pl.xl.longShort"), r.portfolio.long_short === true),
    kv(t("pl.xl.borrowBps"), r.portfolio.borrow_bps ?? null),
    kv(t("pl.xl.borrowCost"), n2(r.portfolio.borrow_cost_pct)),
    kv(t("pl.xl.turnoverPenalty"), r.portfolio.turnover_penalty_bps ?? null),
    kv(t("pl.xl.capacity"), r.capacity?.breakeven_aum ?? null),
    kv(t("pl.md.warnings"), r.warnings.map((w) => (WARNING_KEYS[w] ? t(WARNING_KEYS[w]) : w)).join(" · ") || t("pl.md.none")),
  ];
  const spec = (r.spec ?? {}) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(spec)) {
    overview.push(kv(`spec.${k}`, Array.isArray(v) || (v !== null && typeof v === "object") ? JSON.stringify(v) : (v as string | number | boolean | null)));
  }
  sheet(XLSX, wb, t("pl.xl.sheet.overview"), overview);

  sheet(
    XLSX, wb, t("pl.xl.sheet.weights"),
    r.target_weights.weights.map((w) => ({
      [t("pl.deploy.symbol")]: w.symbol,
      [t("pl.xl.side")]: w.side ?? (w.weight_pct < 0 ? "short" : "long"),
      [t("pl.deploy.weight")]: n2(w.weight_pct),
      [t("pl.xl.rank")]: w.score_rank,
      [t("pl.deploy.sector")]: names.sector(w.symbol, w.group) ?? w.group ?? null,
      [t("pl.xl.groupId")]: w.group ?? null,
    })),
  );

  sheet(
    XLSX, wb, t("pl.xl.sheet.groups"),
    (r.target_weights.groups ?? []).map((g) => ({
      [t("pl.deploy.sector")]: names.sector("", g.group) ?? g.group,
      [t("pl.xl.groupId")]: g.group,
      [t("pl.deploy.weight")]: n2(g.weight_pct),
    })),
  );

  const bench = new Map(r.backtest.benchmark_curve.map((p) => [p.time, p.value]));
  const dd = new Map(r.backtest.drawdown_curve.map((p) => [p.time, p.value]));
  sheet(
    XLSX, wb, t("pl.xl.sheet.equity"),
    r.backtest.equity_curve.map((p) => ({
      [t("pl.xl.date")]: dateOf(p.time),
      [t("pl.bt.strategy")]: n2(p.value),
      [t("fl.bt.bench")]: n2(bench.get(p.time)),
      [t("pl.risk.underwater")]: n2(dd.get(p.time)),
    })),
  );

  sheet(
    XLSX, wb, t("pl.xl.sheet.monthly"),
    r.backtest.monthly_returns.map((m) => ({
      [t("pl.bt.year")]: m.year,
      [t("pl.xl.month")]: m.month,
      [t("pl.bt.strategy")]: n2(m.ret_pct),
      [t("fl.bt.bench")]: n2(m.bench_pct),
      [t("pl.bt.excess")]: n2(m.ret_pct - m.bench_pct),
    })),
  );

  sheet(
    XLSX, wb, t("pl.xl.sheet.alts"),
    r.alternatives.map((a) => ({
      [t("pl.pf.scheme")]: a.scheme,
      [t("bt.totalReturn")]: n2(a.total_return_pct),
      [t("bt.sharpe")]: n2(a.sharpe),
      [t("pl.bt.deltaEq")]: n2(a.delta_sharpe_vs_equal_ann),
      [t("pl.bt.pEq")]: n4(a.p_value_vs_equal),
      [t("pl.bt.psr")]: n4(a.psr),
      [t("bt.maxdd")]: n2(a.max_drawdown_pct),
      [t("pl.bt.vol")]: n2(a.ann_vol_pct),
      [t("pl.bt.turnover")]: n2(a.avg_turnover_pct),
    })),
  );

  const sens = r.sensitivity;
  const sensRows: Row[] = [];
  if (sens) {
    sens.top_n.forEach((tn, i) =>
      sens.rebalance.forEach((rb, j) => {
        const c = sens.cells[i]?.[j];
        sensRows.push({
          [t("pl.pf.topN")]: tn,
          [t("pl.pf.rebalance")]: rb,
          [t("bt.sharpe")]: n2(c?.sharpe),
          [t("pl.bt.excess")]: n2(c?.excess_pct),
          [t("bt.maxdd")]: n2(c?.max_drawdown_pct),
          [t("pl.xl.chosen")]: tn === r.portfolio.top_n && rb === r.portfolio.rebalance,
        });
      }),
    );
  }
  sheet(XLSX, wb, t("pl.xl.sheet.sens"), sensRows);

  const cpcv = r.cpcv;
  sheet(
    XLSX, wb, "CPCV",
    cpcv
      ? cpcv.path_sharpes.map((s, i) => ({
          [t("pl.xl.path")]: i + 1,
          [t("bt.sharpe")]: n2(s),
          [t("pl.risk.days")]: cpcv.path_days[i] ?? null,
          [t("pl.xl.median")]: n2(cpcv.median_sharpe),
          [t("pl.xl.pctPositive")]: n2(cpcv.pct_paths_positive),
          [t("pl.xl.geometry")]: `${cpcv.groups}C${cpcv.k} = ${cpcv.splits} → ${cpcv.paths}; purge ${cpcv.purge_days}, embargo ${cpcv.embargo_days}`,
        }))
      : [],
  );

  sheet(
    XLSX, wb, t("pl.xl.sheet.health"),
    (r.universe.health ?? []).map((h) => ({
      [t("pl.health.symbol")]: h.symbol,
      [t("pl.health.sector")]: names.sector(h.symbol, h.group) ?? h.group,
      [t("pl.health.coverage")]: n2(h.coverage_pct),
      [t("pl.health.gaps")]: h.gaps,
      [t("pl.health.first")]: h.first,
      [t("pl.health.last")]: h.last,
      [t("pl.health.stale")]: h.stale,
      [t("pl.xl.staleDays")]: h.stale_days ?? null,
    })),
  );

  const file = `aiquant-pipeline-${r.universe.market}-${r.universe.to}.xlsx`;
  XLSX.writeFile(wb, file);
  return file;
}

export async function exportTicketWorkbook(
  ticket: PipelineOrders,
  spec: PipelineRunRequest,
  t: Translate,
  sectorLabel: (id: string) => string,
): Promise<string> {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  sheet(
    XLSX, wb, t("pl.xl.sheet.orders"),
    ticket.orders.map((o) => ({
      [t("pl.tk.side")]: o.side,
      [t("pl.deploy.symbol")]: o.symbol,
      [t("pl.tk.shares")]: o.shares,
      [t("pl.tk.price")]: o.price,
      [t("pl.tk.notional")]: n2(o.notional),
      [t("pl.xl.fromWeight")]: n2(o.from_weight_pct),
      [t("pl.xl.toWeight")]: n2(o.to_weight_pct),
      [t("pl.deploy.sector")]: o.group ? sectorLabel(o.group) : null,
    })),
  );
  const sm = ticket.summary;
  const kv = (k: string, v: string | number | boolean | null | undefined): Row => ({ [t("pl.xl.key")]: k, [t("pl.xl.value")]: v === undefined ? null : v });
  sheet(XLSX, wb, t("pl.xl.sheet.summary"), [
    kv(t("pl.xl.asOf"), ticket.as_of),
    kv(t("pl.xl.priceDate"), ticket.price_date),
    kv(t("pl.tk.nav"), ticket.nav),
    kv(t("pl.tk.buy"), sm.buys),
    kv(t("pl.tk.sell"), sm.sells),
    kv(t("pl.xl.buyNotional"), n2(sm.buy_notional)),
    kv(t("pl.xl.sellNotional"), n2(sm.sell_notional)),
    kv(t("pl.bt.turnover"), n2(sm.turnover_pct)),
    kv(t("pl.xl.estCost"), n2(sm.est_cost)),
    kv(t("pl.xl.cashBefore"), n2(sm.cash_before)),
    kv(t("pl.xl.cashAfter"), n2(sm.cash_after)),
    kv(t("pl.xl.exposure"), n2(sm.target_exposure_pct)),
    kv(t("pl.xl.unpriced"), ticket.unpriced.join(", ") || null),
    kv(t("fl.market"), spec.market),
    kv(t("pl.pf.scheme"), spec.scheme ?? null),
    kv(t("pl.pf.topN"), spec.top_n ?? null),
  ]);
  const file = `aiquant-ticket-${ticket.as_of}.xlsx`;
  XLSX.writeFile(wb, file);
  return file;
}
