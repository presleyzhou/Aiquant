import { useState } from "react";
import { useT } from "../i18n";

/** Copies a share URL to the clipboard with a brief confirmation. The URL is
 * built lazily so it always reflects the state at click time. */
export function ShareButton({ url }: { url: () => string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (http / permissions) — silently skip */
    }
  };

  return (
    <button className="btn btn--mini share-btn" onClick={copy} title={t("share.title")}>
      {copied ? t("share.copied") : t("share.copy")}
    </button>
  );
}
