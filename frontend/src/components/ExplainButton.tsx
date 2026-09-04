import { useState } from "react";
import { api, type FactorExplanation } from "../api";
import { useT } from "../i18n";

const STYLE_KEY: Record<string, string> = {
  momentum: "ex.momentum", reversal: "ex.reversal", volatility: "ex.volatility",
  volume: "ex.volume", liquidity: "ex.liquidity", range: "ex.range", mixed: "ex.mixed",
};

/** "🧠 解释" — plain-language reading of a factor expression (light model,
 * server-cached 24h). Turns GP's black-box formulas into hypotheses. */
export function ExplainButton({ expression, market, enabled }: { expression: string; market: string; enabled: boolean }) {
  const { t } = useT();
  const [result, setResult] = useState<FactorExplanation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!enabled) return null;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.factorExplain(expression, market));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="explain">
      {!result && (
        <button className="btn btn--mini" onClick={run} disabled={busy}>
          {busy ? "…" : t("ex.button")}
        </button>
      )}
      {error && <div className="err" style={{ marginTop: 4 }}>{error}</div>}
      {result && (
        <div className="explain__body">
          <span className="fl-badge">{t((STYLE_KEY[result.style] ?? "ex.mixed") as Parameters<typeof t>[0])}</span>
          <p>{result.meaning}</p>
          <p className="dim">⚠ {result.caveat}</p>
        </div>
      )}
    </div>
  );
}
