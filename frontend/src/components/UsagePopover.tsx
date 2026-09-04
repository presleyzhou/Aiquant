import { useEffect, useState } from "react";
import { api, type AiStatus } from "../api";
import { useT } from "../i18n";
import { exportAllData, importAllData } from "../store";

/** Header popover: today's AI spend (calls / tokens by model), the active
 * rate limits, and full local-data export/import for moving between devices. */
export function UsagePopover({ model }: { model: string | null }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api.aiStatus().then(setStatus).catch(() => setStatus(null));
  }, [open]);

  const usage = status?.usage_today;
  const fmt = (n: number) => n.toLocaleString();

  const doExport = () => {
    const blob = new Blob([exportAllData()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aiquant-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = (file: File | undefined) => {
    if (!file) return;
    file.text().then((text) => {
      const n = importAllData(text);
      setImportMsg(n >= 0 ? t("us.imported", { n: String(n) }) : t("us.importFail"));
      if (n >= 0) window.setTimeout(() => location.reload(), 900);
    });
  };

  return (
    <span className="usage">
      <button className="status status--btn" onClick={() => setOpen(!open)} title={t("us.title")}>
        <span className="dot dot--on" /> AI {model ?? t("status.ai.off")}
      </button>
      {open && (
        <div className="usage__panel">
          <div className="usage__head">{t("us.title")}</div>
          {usage ? (
            <>
              <div className="usage__row"><span className="dim">{t("us.calls")}</span><b>{usage.calls}</b></div>
              <div className="usage__row"><span className="dim">{t("us.in")}</span><b>{fmt(usage.input_tokens)}</b></div>
              <div className="usage__row"><span className="dim">{t("us.out")}</span><b>{fmt(usage.output_tokens)}</b></div>
              {Object.entries(usage.by_model).map(([m, u]) => (
                <div className="usage__row usage__row--sub" key={m}>
                  <span className="dim">{m}</span>
                  <span>{u.calls} · {fmt(u.input_tokens + u.output_tokens)} tok</span>
                </div>
              ))}
              {status?.limits && (
                <div className="usage__limits dim">
                  {t("us.limits")}: {Object.entries(status.limits).map(([k, v]) => `${k.replace(/_per_(hour|day)/, (_m, w) => (w === "hour" ? "/h" : "/d"))} ${v}`).join(" · ")}
                </div>
              )}
            </>
          ) : (
            <div className="dim">{status ? t("us.none") : "…"}</div>
          )}
          <div className="usage__data">
            <div className="usage__head">{t("us.data")}</div>
            <div className="usage__actions">
              <button className="btn btn--mini" onClick={doExport}>{t("us.export")}</button>
              <label className="btn btn--mini">
                {t("us.import")}
                <input type="file" accept="application/json" hidden onChange={(e) => doImport(e.target.files?.[0])} />
              </label>
            </div>
            {importMsg && <div className="dim" style={{ fontSize: 11 }}>{importMsg}</div>}
            <div className="dim" style={{ fontSize: 11 }}>{t("us.dataNote")}</div>
          </div>
        </div>
      )}
    </span>
  );
}
