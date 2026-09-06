import { useEffect, useState } from "react";
import { useT, type MsgKey } from "../i18n";

/** 课堂演示模式 — a guided walkthrough of the factor-mining page that follows
 * the 14-slide lecture: each step scrolls the matching control into view and
 * highlights it. Nothing runs automatically; the presenter clicks. */
const STEPS: Array<{ target: string; slide: number; title: MsgKey; body: MsgKey }> = [
  { target: "engine", slide: 7, title: "lt.1.title", body: "lt.1.body" },
  { target: "form", slide: 6, title: "lt.2.title", body: "lt.2.body" },
  { target: "loop", slide: 8, title: "lt.3.title", body: "lt.3.body" },
  { target: "zoo", slide: 9, title: "lt.4.title", body: "lt.4.body" },
  { target: "library", slide: 11, title: "lt.5.title", body: "lt.5.body" },
  { target: "report", slide: 12, title: "lt.6.title", body: "lt.6.body" },
  { target: "composite", slide: 11, title: "lt.7.title", body: "lt.7.body" },
  { target: "deploy", slide: 12, title: "lt.8.title", body: "lt.8.body" },
];

export function LectureTour({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const current = STEPS[step];

  useEffect(() => {
    document.querySelectorAll(".lt-highlight").forEach((el) => el.classList.remove("lt-highlight"));
    const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
    if (el) {
      el.classList.add("lt-highlight");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return () => el?.classList.remove("lt-highlight");
  }, [current]);

  return (
    <div className="lt-card" role="dialog" aria-label={t("lt.title")}>
      <div className="lt-card__head">
        <span className="lt-card__step">{t("lt.step", { k: String(step + 1), n: String(STEPS.length), s: String(current.slide) })}</span>
        <button className="mk-close" onClick={onClose} aria-label={t("mk.close")}>✕</button>
      </div>
      <h3 className="lt-card__title">{t(current.title)}</h3>
      <p className="lt-card__body">{t(current.body)}</p>
      <div className="lt-card__foot">
        <button className="btn btn--mini" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>{t("lt.prev")}</button>
        <span className="tour-dots">{STEPS.map((_, i) => <span key={i} className={`tour-dot ${i === step ? "is-on" : ""}`} />)}</span>
        {step < STEPS.length - 1 ? (
          <button className="btn btn--mini btn--primary" onClick={() => setStep((s) => s + 1)}>{t("lt.next")}</button>
        ) : (
          <button className="btn btn--mini btn--primary" onClick={onClose}>{t("lt.done")}</button>
        )}
      </div>
    </div>
  );
}
