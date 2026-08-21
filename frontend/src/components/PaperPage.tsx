import { useEffect, useState } from "react";
import { api, type PaperTrack } from "../api";
import { useT } from "../i18n";
import { deletePaper, savedPaper, type PaperDeployment } from "../store";
import { EquityChart } from "./EquityChart";

interface Props {
  hidden: boolean;
}

/** Forward (out-of-sample by construction) tracking of deployed configs.
 * Backtests are honesty about the past; this page is honesty about what has
 * happened SINCE the user clicked deploy — recomputed fresh on every visit. */
export function PaperPage({ hidden }: Props) {
  const { t } = useT();
  const [deployments, setDeployments] = useState<PaperDeployment[]>(savedPaper);
  const [tracks, setTracks] = useState<Record<string, PaperTrack | "loading" | string>>({});
  const [loadedOnce, setLoadedOnce] = useState(false);

  // Refresh NAV curves whenever the tab becomes visible with deployments.
  useEffect(() => {
    if (hidden) return;
    const current = savedPaper();
    setDeployments(current);
    if (current.length === 0 || loadedOnce) return;
    setLoadedOnce(true);
    for (const dep of current) {
      setTracks((prev) => ({ ...prev, [dep.id]: "loading" }));
      api
        .paperTrack({ kind: dep.kind, started_at: dep.startedAt, config: dep.config })
        .then((track) => setTracks((prev) => ({ ...prev, [dep.id]: track })))
        .catch((err: Error) => setTracks((prev) => ({ ...prev, [dep.id]: err.message })));
    }
  }, [hidden, loadedOnce]);

  const remove = (id: string) => {
    setDeployments(deletePaper(id));
    setTracks((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  return (
    <div className="lab" style={hidden ? { display: "none" } : undefined}>
      <div className="lab__inner">
        <section className="lab-hero">
          <h1 className="lab-hero__title">{t("pp.title")}</h1>
          <p className="lab-hero__sub">
            {t("pp.sub1")}
            <b>{t("pp.sub.b")}</b>
            {t("pp.sub2")}
          </p>
        </section>

        {deployments.length === 0 ? (
          <div className="notice" style={{ maxWidth: 620 }}>{t("pp.empty")}</div>
        ) : (
          <div className="pp-grid">
            {deployments.map((dep) => {
              const track = tracks[dep.id];
              return (
                <div key={dep.id} className="panel pp-card">
                  <div className="panel__head">
                    <span className="panel__title">
                      {dep.kind === "factor" ? "⛏" : "📈"} {dep.name}
                    </span>
                    <span className="panel__meta">
                      {t("pp.since", { d: dep.startedAt })}
                      <button
                        className="watch-row__x"
                        style={{ marginLeft: 8 }}
                        title={t("pp.remove")}
                        onClick={() => remove(dep.id)}
                      >
                        ×
                      </button>
                    </span>
                  </div>

                  {track === "loading" || track === undefined ? (
                    <div className="empty" style={{ padding: 28 }}>{t("pp.loading")}</div>
                  ) : typeof track === "string" ? (
                    <div className="err">{track}</div>
                  ) : (
                    <>
                      <EquityChart
                        equity={track.equity_curve}
                        benchmark={track.benchmark_curve}
                        drawdown={[]}
                      />
                      <div className="stat-grid">
                        <Stat
                          label={t("pp.liveReturn", { n: String(track.days_live) })}
                          value={pct(track.stats.return_pct)}
                          tone={track.stats.return_pct}
                        />
                        <Stat
                          label={t("pp.bench")}
                          value={pct(track.stats.bench_return_pct)}
                          tone={track.stats.bench_return_pct}
                        />
                        <Stat
                          label={t("pp.excess")}
                          value={pct(track.stats.excess_pct)}
                          tone={track.stats.excess_pct}
                        />
                        <Stat
                          label={t("bt.maxdd")}
                          value={pct(track.stats.max_drawdown_pct)}
                          tone={-1}
                        />
                      </div>
                      <div className="kr-disclaimer dim">
                        {t("pp.note", { d: track.as_of })}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="lab-disclaimer">{t("pp.disclaimer")}</p>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const cls = tone === undefined ? "" : tone > 0 ? "up" : tone < 0 ? "dn" : "";
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value ${cls}`}>{value}</div>
    </div>
  );
}

const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
