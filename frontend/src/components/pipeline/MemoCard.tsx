import { useEffect, useState } from "react";
import { api, type PipelineMemo, type PipelineResult } from "../../api";
import { useT, type Lang, type MsgKey } from "../../i18n";
import { memoRequest } from "./report";

/** AI investment-committee memo (stage ⑥). The button is live only when the
 * server reports an AI key; a new run clears the previous memo so the verdict
 * always refers to the numbers on screen. */
export function MemoCard({ result, enabled, lang }: { result: PipelineResult; enabled: boolean; lang: Lang }) {
  const { t } = useT();
  const [memo, setMemo] = useState<PipelineMemo | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMemo(null);
    setError(null);
  }, [result]);

  const generate = async () => {
    if (pending || !enabled) return;
    setPending(true);
    setError(null);
    try {
      setMemo(await api.pipelineMemo(memoRequest(result, lang)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="pl-memo" data-testid="pl-memo">
      <div className="pl-memo__head">
        <span className="pl-subhead" style={{ marginTop: 0 }}>{t("pl.memo.title")}</span>
        <button
          className="btn btn--mini"
          onClick={generate}
          disabled={!enabled || pending}
          data-testid="pl-memo-btn"
        >
          {pending ? t("pl.memo.loading") : t("pl.memo.button")}
        </button>
        {pending && <span className="spinner" aria-hidden="true" />}
        {!enabled && <span className="dim pl-hint" data-testid="pl-memo-disabled">{t("pl.memo.disabled")}</span>}
      </div>
      {!memo && !error && <p className="dim pl-hint">{t("pl.memo.hint")}</p>}
      {error && <div className="err">{error}</div>}
      {memo && (
        <>
          <div className="pl-memo__head">
            <span className={`pl-verdict pl-verdict--${memo.verdict}`} data-testid="pl-memo-verdict">
              {t(`pl.memo.verdict.${memo.verdict}` as MsgKey)}
            </span>
            <p className="pl-memo__headline" data-testid="pl-memo-headline">{memo.headline}</p>
          </div>
          <div className="pl-memo__lists">
            <MemoList title={t("pl.memo.strengths")} items={memo.strengths} />
            <MemoList title={t("pl.memo.concerns")} items={memo.concerns} />
            <MemoList title={t("pl.memo.next")} items={memo.next_steps} />
          </div>
          {memo.honesty_note && <p className="dim pl-hint">{memo.honesty_note}</p>}
          <div className="pl-memo__footer">{t("pl.memo.footer", { model: memo.model })}</div>
        </>
      )}
    </div>
  );
}

export function MemoList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="pl-subhead">{title}</div>
      <ul className="pl-memo__list">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
