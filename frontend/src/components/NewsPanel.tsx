import { useEffect, useState } from "react";
import { api, type NewsArticle, type NewsSummary } from "../api";
import { useT } from "../i18n";

interface Props {
  symbol: string;
  aiEnabled: boolean;
}

const STANCE_CLASS: Record<string, string> = {
  bullish: "up",
  bearish: "dn",
  neutral: "dim",
  mixed: "dim",
};

/** Headlines for the active symbol (free, cached server-side) plus an
 * on-demand three-sentence Claude sentiment read — the platform's first
 * rate-limited AI endpoint (10/day per IP), so the button says so. */
export function NewsPanel({ symbol, aiEnabled }: Props) {
  const { t } = useT();
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<NewsSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setSummary(null);
    setError(null);
    api
      .symbolNews(symbol)
      .then((res) => {
        if (!stale) setArticles(res.articles ?? []);
      })
      .catch(() => {
        if (!stale) setArticles([]);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [symbol]);

  const summarize = async () => {
    if (summarizing) return;
    setSummarizing(true);
    setError(null);
    try {
      setSummary(await api.newsSummary(symbol));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <div className="panel news-panel">
      <div className="panel__head">
        <span className="panel__title">{t("nw.title")}</span>
        <span className="panel__meta">{symbol}</span>
      </div>

      {summary && (
        <div className="nw-summary">
          <span className={`nw-stance ${STANCE_CLASS[summary.stance] ?? "dim"}`}>
            {t(`nw.stance.${summary.stance}` as Parameters<typeof t>[0])}
          </span>
          <p>{summary.summary}</p>
          <div className="dim" style={{ fontSize: 11 }}>
            {t("nw.basedOn", { n: String(summary.article_count) })}
            {summary.cached && ` · ${t("nw.cached")}`}
          </div>
        </div>
      )}
      {error && <div className="err">{error}</div>}

      {loading ? (
        <div className="empty" style={{ padding: 14 }}>…</div>
      ) : articles.length === 0 ? (
        <div className="empty" style={{ padding: 14 }}>{t("nw.none")}</div>
      ) : (
        <ul className="nw-list">
          {articles.slice(0, 6).map((a) => (
            <li key={a.title}>
              <a href={a.url || undefined} target="_blank" rel="noreferrer noopener">
                {a.title}
              </a>
              <span className="dim"> · {a.publisher}</span>
            </li>
          ))}
        </ul>
      )}

      {aiEnabled && articles.length > 0 && !summary && (
        <div className="nw-actions">
          <button className="btn btn--mini" onClick={summarize} disabled={summarizing}>
            {summarizing ? t("nw.summarizing") : t("nw.summarize")}
          </button>
        </div>
      )}
    </div>
  );
}
