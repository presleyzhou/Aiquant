import { useEffect, useMemo, useState } from "react";
import { api, type PipelineOrder, type PipelineOrders, type PipelineRunRequest } from "../../api";
import { useT } from "../../i18n";
import { copyText } from "./clipboard";
import { MIN_TRADE_RANGE } from "./constants";
import { parseHoldings } from "./form";
import { money, price } from "./format";

/** V5 rebalance ticket (stage ⑥): NAV + current holdings → whole-share buy /
 * sell orders against the latest target book. The spec posted is the run on
 * screen (or the form's when none), so the ticket matches the numbers above;
 * a new run clears the previous ticket for the same reason. */
export function TicketCard({ spec, sectorLabel }: { spec: PipelineRunRequest; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  const [nav, setNav] = useState<number>(100000);
  const [holdingsText, setHoldingsText] = useState("");
  const [minTradePct, setMinTradePct] = useState<number>(0.25);
  const [ticket, setTicket] = useState<PipelineOrders | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvCopied, setCsvCopied] = useState<"idle" | "ok" | "fail">("idle");

  // Keyed on content, not identity: the caller may rebuild the spec object per render.
  const specKey = JSON.stringify(spec);
  useEffect(() => {
    setTicket(null);
    setError(null);
  }, [specKey]);

  const lines = useMemo(() => parseHoldings(holdingsText), [holdingsText]);
  const badLines = lines.filter((l) => l.symbol === undefined);
  const navOk = Number.isFinite(nav) && nav > 0;
  const minOk = Number.isFinite(minTradePct) && minTradePct >= MIN_TRADE_RANGE[0] && minTradePct <= MIN_TRADE_RANGE[1];
  const issue = !navOk ? t("pl.tk.navInvalid") : !minOk ? t("pl.tk.minInvalid") : badLines.length > 0 ? t("pl.tk.fixLines") : null;

  const build = async () => {
    if (pending || issue !== null) return;
    setPending(true);
    setError(null);
    setCsvCopied("idle");
    const current: Record<string, number> = {};
    for (const l of lines) {
      if (l.symbol === undefined || l.shares === undefined) continue;
      current[l.symbol] = (current[l.symbol] ?? 0) + l.shares;
    }
    try {
      setTicket(await api.pipelineOrders({ spec, nav, current, min_trade_pct: minTradePct }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  const copyCsv = async () => {
    if (!ticket) return;
    const rows = [
      "side,symbol,shares,price,notional,from_weight_pct,to_weight_pct,group",
      ...ticket.orders.map((o) =>
        [o.side, o.symbol, o.shares, o.price, o.notional.toFixed(2), o.from_weight_pct.toFixed(2), o.to_weight_pct.toFixed(2), o.group ?? ""].join(","),
      ),
    ];
    const ok = await copyText(rows.join("\n"));
    setCsvCopied(ok ? "ok" : "fail");
    window.setTimeout(() => setCsvCopied("idle"), 2500);
  };

  const sm = ticket?.summary;
  return (
    <div className="pl-ticket" data-testid="pl-ticket">
      <div className="pl-memo__head">
        <span className="pl-subhead" style={{ marginTop: 0 }}>{t("pl.tk.title")}</span>
        {ticket && (
          <span className="dim pl-hint" data-testid="pl-ticket-dates">
            {t("pl.tk.asOf", { d: ticket.as_of, p: ticket.price_date })}
          </span>
        )}
      </div>
      <p className="dim pl-hint">{t("pl.tk.hint")}</p>
      <div className="pl-ticket__form">
        <label className="field">
          <span className="field__label">{t("pl.tk.nav")}</span>
          <input
            type="number"
            className="input pl-num-input"
            value={Number.isFinite(nav) ? nav : ""}
            min={1}
            step={1000}
            onChange={(e) => setNav(e.target.value === "" ? Number.NaN : Number(e.target.value))}
            aria-label={t("pl.tk.nav")}
            data-testid="pl-ticket-nav"
          />
        </label>
        <label className="field">
          <span className="field__label">
            {t("pl.tk.minTrade")} <span className="pl-range">{MIN_TRADE_RANGE[0]}–{MIN_TRADE_RANGE[1]}</span>
          </span>
          <input
            type="number"
            className="input pl-num-input"
            value={Number.isFinite(minTradePct) ? minTradePct : ""}
            min={MIN_TRADE_RANGE[0]}
            max={MIN_TRADE_RANGE[1]}
            step={0.05}
            onChange={(e) => setMinTradePct(e.target.value === "" ? Number.NaN : Number(e.target.value))}
            aria-label={t("pl.tk.minTrade")}
            data-testid="pl-ticket-min"
          />
        </label>
        <label className="field pl-ticket__holdings">
          <span className="field__label">{t("pl.tk.holdings")}</span>
          <textarea
            className="textarea pl-symbols"
            value={holdingsText}
            placeholder={t("pl.tk.holdingsPh")}
            onChange={(e) => setHoldingsText(e.target.value)}
            aria-label={t("pl.tk.holdings")}
            spellCheck={false}
            data-testid="pl-ticket-holdings"
          />
          {badLines.length > 0 && (
            <ul className="pl-badlines" data-testid="pl-ticket-badlines">
              {badLines.map((l) => (
                <li key={l.line}>⚠ {t("pl.tk.badLine", { n: l.line, s: l.text })}</li>
              ))}
            </ul>
          )}
        </label>
      </div>
      <div className="pl-runbar">
        <button className="btn btn--primary" onClick={build} disabled={pending || issue !== null} title={issue ?? undefined} data-testid="pl-ticket-build">
          {pending ? t("pl.tk.building") : t("pl.tk.build")}
        </button>
        {pending && <span className="spinner" aria-hidden="true" />}
        {issue && <span className="pl-hint pl-hint--warn" data-testid="pl-ticket-issue">{issue}</span>}
        {ticket && (
          <>
            <button className="btn" onClick={copyCsv} data-testid="pl-ticket-csv">
              {t("pl.tk.copyCsv")}
            </button>
            {csvCopied === "ok" && <span className="pl-badge pl-badge--ok" data-testid="pl-ticket-csv-copied">✓ {t("pl.deploy.copied")}</span>}
            {csvCopied === "fail" && <span className="pl-badge pl-badge--warn">{t("pl.deploy.copyFailed")}</span>}
          </>
        )}
      </div>
      {error && <div className="err" data-testid="pl-ticket-error">{error}</div>}
      {ticket && sm && (
        <>
          <div className="chip-row pl-chip-row" data-testid="pl-ticket-summary">
            <span className="chip">{t("pl.tk.counts", { b: sm.buys, s: sm.sells })}</span>
            <span className="chip" title={t("pl.tk.turnoverTitle")} data-testid="pl-ticket-turnover">
              {t("pl.tk.turnover", { v: sm.turnover_pct.toFixed(1) })}
            </span>
            <span className="chip" title={t("pl.tk.costTitle")}>{t("pl.tk.cost", { v: money(sm.est_cost) })}</span>
            {sm.cash_unknown || sm.cash_before === null || sm.cash_after === null ? (
              <span className="chip pl-tone--warn" title={t("pl.tk.unpriced", { list: ticket.unpriced.join(", ") })} data-testid="pl-ticket-cash-unknown">
                {t("pl.tk.cashUnknown")}
              </span>
            ) : (
              <span className="chip" data-testid="pl-ticket-cash">{t("pl.tk.cash", { a: money(sm.cash_before), b: money(sm.cash_after) })}</span>
            )}
            <span className="chip">{t("pl.tk.exposure", { v: sm.target_exposure_pct.toFixed(0) })}</span>
          </div>
          {ticket.unpriced.length > 0 && (
            <div className="pl-badge pl-badge--warn pl-dropped" data-testid="pl-ticket-unpriced">
              ⚠ {t("pl.tk.unpriced", { list: ticket.unpriced.join(", ") })}
            </div>
          )}
          {ticket.orders.length === 0 ? (
            <div className="empty">{t("pl.tk.empty")}</div>
          ) : (
            <div className="table-scroll pl-weights-scroll">
              <table className="lab-stats pl-orders" data-testid="pl-ticket-table">
                <thead>
                  <tr>
                    <th>{t("pl.tk.side")}</th>
                    <th>{t("pl.deploy.symbol")}</th>
                    <th className="pl-num">{t("pl.tk.shares")}</th>
                    <th className="pl-num">{t("pl.tk.price")}</th>
                    <th className="pl-num">{t("pl.tk.notional")}</th>
                    <th className="pl-num">{t("pl.tk.weights")}</th>
                    <th>{t("pl.deploy.sector")}</th>
                  </tr>
                </thead>
                <tbody>
                  {ticket.orders.map((o) => (
                    <OrderRow key={`${o.side}-${o.symbol}`} o={o} sectorLabel={sectorLabel} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="dim pl-hint" data-testid="pl-ticket-note">{t("pl.tk.note")}</p>
        </>
      )}
    </div>
  );
}

export function OrderRow({ o, sectorLabel }: { o: PipelineOrder; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  return (
    <tr className={`pl-order pl-order--${o.side}`} data-side={o.side}>
      <td>
        <span className={`pl-side pl-side--${o.side}`}>{o.side === "buy" ? t("pl.tk.buy") : t("pl.tk.sell")}</span>
      </td>
      <td><b>{o.symbol}</b></td>
      <td className="pl-num">{o.shares.toLocaleString("en-US")}</td>
      <td className="pl-num">{price(o.price)}</td>
      <td className="pl-num">{money(o.notional)}</td>
      <td className="pl-num">
        <span className="dim">{o.from_weight_pct.toFixed(1)}%</span> → {o.to_weight_pct.toFixed(1)}%
      </td>
      <td className="dim">{o.group ? sectorLabel(o.group) : "—"}</td>
    </tr>
  );
}
