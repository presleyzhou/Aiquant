import { useState } from "react";
import { useT, type MsgKey } from "../i18n";

const TOUR_KEY = "aiquant.tour.done";

const STEPS: Array<{ icon: string; title: MsgKey; body: MsgKey }> = [
  { icon: "📈", title: "tour.1.title", body: "tour.1.body" },
  { icon: "🧪", title: "tour.2.title", body: "tour.2.body" },
  { icon: "🔮", title: "tour.3.title", body: "tour.3.body" },
  { icon: "⛏", title: "tour.4.title", body: "tour.4.body" },
];

/** First-visit walkthrough: four cards covering the workflow
 * watchlist → backtest → forecast → factor mining. Dismissed state persists,
 * so returning visitors (and E2E runs, which pre-seed the flag) never see it. */
export function Tour() {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(TOUR_KEY) !== "1";
    } catch {
      return false;
    }
  });

  if (!open) return null;

  const finish = () => {
    try {
      localStorage.setItem(TOUR_KEY, "1");
    } catch {
      /* private mode */
    }
    setOpen(false);
  };

  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div className="tour-backdrop" data-testid="tour">
      <div className="tour-card" role="dialog" aria-modal="true">
        <div className="tour-card__step">
          {t("tour.step", { k: String(step + 1), n: String(STEPS.length) })}
        </div>
        <div className="tour-card__icon">{current.icon}</div>
        <h2 className="tour-card__title">{t(current.title)}</h2>
        <p className="tour-card__body">{t(current.body)}</p>
        <div className="tour-card__foot">
          <button className="btn" onClick={finish}>
            {t("tour.skip")}
          </button>
          <div className="tour-dots">
            {STEPS.map((_, i) => (
              <span key={i} className={`tour-dot ${i === step ? "is-on" : ""}`} />
            ))}
          </div>
          <button
            className="btn btn--primary"
            onClick={() => (last ? finish() : setStep(step + 1))}
          >
            {last ? t("tour.done") : t("tour.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
