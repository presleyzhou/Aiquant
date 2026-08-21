import { useState } from "react";
import { useT } from "../i18n";

/** "Go live" — freezes the current config as a paper deployment dated today.
 * The paper page then tracks it forward, out-of-sample by construction. */
export function DeployButton({ onDeploy }: { onDeploy: () => void }) {
  const { t } = useT();
  const [done, setDone] = useState(false);

  return (
    <button
      className="btn btn--mini share-btn"
      title={t("pp.deployTitle")}
      onClick={() => {
        if (done) return;
        onDeploy();
        setDone(true);
        window.setTimeout(() => setDone(false), 2500);
      }}
    >
      {done ? t("pp.deployed") : t("pp.deploy")}
    </button>
  );
}
