import { useState } from "react";
import { requestNotifyPermission } from "../hooks/useAlerts";
import { useT } from "../i18n";
import {
  deleteAlert,
  rearmAlert,
  saveAlert,
  savedAlerts,
  type PriceAlert,
} from "../store";

interface Props {
  symbols: string[];
  /** bumped by the rule engine when an alert fires, so the list re-reads */
  version: number;
  onChange: () => void;
}

/** Price-level alerts for the current workspace's symbols. Rules live in
 * this browser; the page must be open for them to fire (the quote stream is
 * client-side). Triggered alerts show struck-through until re-armed. */
export function AlertsPanel({ symbols, version, onChange }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState(symbols[0] ?? "");
  const [dir, setDir] = useState<"above" | "below">("above");
  const [price, setPrice] = useState("");

  void version; // dependency: re-render when the engine fires

  const alerts = savedAlerts().filter((a) => symbols.includes(a.symbol));

  const add = () => {
    const level = Number(price);
    if (!symbol || !Number.isFinite(level) || level <= 0) return;
    requestNotifyPermission();
    saveAlert(symbol, dir, level);
    setPrice("");
    onChange();
  };

  return (
    <div className="alerts">
      <button
        className={`btn btn--mini ${alerts.some((a) => !a.triggeredAt) ? "alerts__bell--armed" : ""}`}
        title={t("al.title")}
        onClick={() => setOpen(!open)}
      >
        🔔{alerts.length > 0 && ` ${alerts.length}`}
      </button>

      {open && (
        <div className="alerts__panel">
          <div className="alerts__form">
            <select className="select" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              className="select"
              value={dir}
              onChange={(e) => setDir(e.target.value as "above" | "below")}
            >
              <option value="above">{t("al.above")}</option>
              <option value="below">{t("al.below")}</option>
            </select>
            <input
              className="input"
              type="number"
              min={0}
              step="any"
              placeholder={t("al.pricePh")}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button className="btn btn--primary btn--mini" onClick={add}>
              {t("al.add")}
            </button>
          </div>

          {alerts.length === 0 ? (
            <div className="alerts__empty dim">{t("al.empty")}</div>
          ) : (
            <ul className="alerts__list">
              {alerts.map((a: PriceAlert) => (
                <li key={a.id} className={a.triggeredAt ? "alerts__row is-fired" : "alerts__row"}>
                  <span>
                    {a.symbol} {a.dir === "above" ? "↑" : "↓"} {a.price}
                    {a.triggeredAt && <em className="dim"> · {t("al.fired")}</em>}
                  </span>
                  <span className="alerts__actions">
                    {a.triggeredAt && (
                      <button
                        className="btn btn--mini"
                        onClick={() => {
                          rearmAlert(a.id);
                          onChange();
                        }}
                      >
                        {t("al.rearm")}
                      </button>
                    )}
                    <button
                      className="watch-row__x"
                      onClick={() => {
                        deleteAlert(a.id);
                        onChange();
                      }}
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="alerts__note dim">{t("al.note")}</div>
        </div>
      )}
    </div>
  );
}
