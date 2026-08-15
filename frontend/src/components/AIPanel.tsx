import { useEffect, useRef, useState } from "react";
import { streamAnalysis, type AIEvent } from "../api";
import { useT } from "../i18n";
import { EVENTS, installedSkills, type InstalledSkill } from "../store";

interface ToolCall {
  name: string;
  input: unknown;
  result?: unknown;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools?: ToolCall[];
  refusal?: string;
}

interface Props {
  enabled: boolean;
  model: string | null;
  symbol: string;
}

export function AIPanel({ enabled, model, symbol }: Props) {
  const { t } = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<InstalledSkill[]>(installedSkills);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Skills installed from the marketplace surface here as one-click prompts.
  useEffect(() => {
    const refresh = () => setSkills(installedSkills());
    window.addEventListener(EVENTS.installed, refresh);
    return () => window.removeEventListener(EVENTS.installed, refresh);
  }, []);

  const suggestions: Array<{ label: string; prompt: string; skill?: boolean }> = [
    ...skills.map((s) => ({
      label: s.name,
      prompt: s.template.replaceAll("{symbol}", symbol),
      skill: true,
    })),
    { label: "", prompt: t("ai.sugg1", { sym: symbol }) },
    { label: "", prompt: t("ai.sugg2", { sym: symbol }) },
    { label: "", prompt: t("ai.sugg3", { sym: symbol }) },
  ];

  const send = async (content: string) => {
    if (!content.trim() || busy) return;

    const history = turns
      .filter((t) => t.text.trim() && !t.refusal)
      .map((t) => ({ role: t.role, content: t.text }));
    const outgoing = [...history, { role: "user", content }];

    setTurns((prev) => [...prev, { role: "user", text: content }, { role: "assistant", text: "" }]);
    setDraft("");
    setBusy(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    // Mutate only the trailing assistant turn as events arrive.
    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = fn(next[next.length - 1]);
        return next;
      });

    try {
      await streamAnalysis(
        outgoing,
        (event: AIEvent) => {
          switch (event.type) {
            case "text":
              patch((t) => ({ ...t, text: t.text + event.text }));
              break;
            case "thinking":
              patch((t) => ({ ...t, thinking: (t.thinking ?? "") + event.text }));
              break;
            case "tool_use":
              patch((t) => ({
                ...t,
                tools: [...(t.tools ?? []), { name: event.name, input: event.input }],
              }));
              break;
            case "tool_result":
              patch((t) => {
                const tools = [...(t.tools ?? [])];
                for (let i = tools.length - 1; i >= 0; i--) {
                  if (tools[i].name === event.name && tools[i].result === undefined) {
                    tools[i] = { ...tools[i], result: event.result };
                    break;
                  }
                }
                return { ...t, tools };
              });
              break;
            case "refusal":
              patch((t) => ({ ...t, refusal: event.message }));
              break;
            case "error":
              setError(event.message);
              break;
            case "done":
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="panel panel--grow">
      <div className="panel__head">
        <span className="panel__title">{t("ai.title")}</span>
        <span className="panel__meta">{enabled ? model : t("ai.disabled")}</span>
      </div>

      {!enabled ? (
        <div className="panel__body">
          <div className="notice">{t("ai.notice")}</div>
        </div>
      ) : (
        <div className="chat">
          <div className="chat__log" ref={logRef}>
            {turns.length === 0 && (
              <div className="empty">{t("ai.empty")}</div>
            )}

            {turns.map((turn, i) => (
              <div key={i} className={`msg msg--${turn.role}`}>
                <div className="msg__role">{turn.role === "user" ? t("ai.you") : "Claude"}</div>

                {turn.thinking && <div className="msg__thinking">{turn.thinking}</div>}

                {turn.tools?.map((tool, j) => (
                  <div className="tool-call" key={j}>
                    <span className="tool-call__name">⚙ {tool.name}</span>
                    <span className="dim"> {JSON.stringify(tool.input)}</span>
                    {tool.result !== undefined && (
                      <pre>{truncate(JSON.stringify(tool.result), 600)}</pre>
                    )}
                  </div>
                ))}

                {turn.refusal && <div className="err" style={{ padding: 0 }}>{turn.refusal}</div>}

                <div className="msg__body">
                  {turn.text}
                  {busy && i === turns.length - 1 && turn.role === "assistant" && (
                    <span className="dim"> ▊</span>
                  )}
                </div>
              </div>
            ))}

            {error && <div className="err">{error}</div>}
          </div>

          {turns.length === 0 && (
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s.prompt} className="suggestion" onClick={() => send(s.prompt)}>
                  {s.skill ? (
                    <span className="skill-chip">
                      <span className="skill-chip__dot" />
                      <b>{s.label}</b>
                      <span className="dim">{t("ai.skill")}</span>
                    </span>
                  ) : (
                    s.prompt
                  )}
                </button>
              ))}
            </div>
          )}

          <form
            className="chat__form"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <textarea
              className="textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              placeholder={t("ai.ph", { sym: symbol })}
              disabled={busy}
            />
            <button className="btn btn--primary" type="submit" disabled={busy || !draft.trim()}>
              {busy ? "…" : t("ai.send")}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
