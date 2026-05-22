import { useState } from "react";

import { useCodexStatus } from "@/lib/query/agents";
import { useCodexModel, useSetCodexModel } from "@/lib/query/agentsConfig";

/**
 * 에이전트 설정 패널 (B2 Part B).
 * - Codex 설치/인증 상태 표시.
 * - Codex 모델 설정: 자유 입력 + 공통 프리셋. app_config(SQLite) 영속, 비밀 아님.
 * - 미설정이면 codex 기본 동작(모델 플래그 없음).
 */
export function AgentsPane({ onToast }: { onToast: (msg: string) => void }) {
  const status = useCodexStatus();
  const model = useCodexModel();
  const setModel = useSetCodexModel();

  const [draft, setDraft] = useState<string | null>(null);
  // draft가 null이면 서버 값을 표시, 편집 중이면 draft 값.
  const displayValue = draft !== null ? draft : (model.data ?? "");

  const avail = status.data;

  const save = () => {
    const val = (draft ?? "").trim();
    setModel.mutate(val || null, {
      onSuccess: () => {
        setDraft(null);
        onToast(val ? `Codex 모델 설정됨: ${val}` : "Codex 모델 기본값으로 초기화됨");
      },
      onError: (e) => onToast(String(e)),
    });
  };

  const reset = () => {
    setModel.mutate(null, {
      onSuccess: () => {
        setDraft(null);
        onToast("Codex 모델 기본값으로 초기화됨");
      },
      onError: (e) => onToast(String(e)),
    });
  };

  const PRESETS = [
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "o4-mini",
    "o3",
  ];

  return (
    <div className="st-token">
      {/* Codex 상태 */}
      <div className="st-token-head">
        <span className="st-token-lbl">Codex CLI</span>
        <span className={avail?.installed ? "st-status on" : "st-status"}>
          {avail === undefined
            ? "확인 중…"
            : avail.installed
              ? avail.authed
                ? `● 설치·로그인됨 (${avail.version ?? ""})`
                : "○ 설치됨 / 미로그인"
              : "○ 미설치"}
        </span>
      </div>
      {avail && !avail.installed && (
        <div className="st-hint">
          codex CLI를 설치하세요: <code>npm install -g @openai/codex</code> 후 재시작.
        </div>
      )}
      {avail && avail.installed && !avail.authed && (
        <div className="st-hint">
          <code>codex login</code>을 실행해 인증하세요.
        </div>
      )}
      {avail?.detail && avail.installed && (
        <div className="st-hint">{avail.detail}</div>
      )}

      {/* Codex 모델 설정 */}
      <div className="st-section-lbl" style={{ marginTop: 18 }}>
        Codex 모델
      </div>
      <div className="st-token-row">
        <input
          className="st-input"
          value={displayValue}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="기본값 (미설정 시 codex 내장 모델)"
          aria-label="Codex 모델"
          style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
        />
        <button
          type="button"
          className="st-btn sm"
          onClick={save}
          disabled={
            setModel.isPending ||
            (draft === null || draft.trim() === (model.data ?? ""))
          }
        >
          {setModel.isPending ? "저장 중…" : "저장"}
        </button>
        {(model.data || draft) && (
          <button
            type="button"
            className="st-btn-ghost sm"
            onClick={reset}
            disabled={setModel.isPending}
          >
            초기화
          </button>
        )}
      </div>

      {/* 공통 프리셋 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className="st-btn-ghost sm"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              background:
                displayValue === p ? "var(--color-wr-surface)" : undefined,
            }}
            onClick={() => setDraft(p)}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="st-hint" style={{ marginTop: 8 }}>
        미설정 시 codex CLI 기본 모델을 사용합니다. 설정하면 모든 에이전트 잡에{" "}
        <code>--model</code> 플래그로 전달됩니다. 재시작 없이 다음 잡부터 적용됩니다.
      </div>

      {model.isError && <div className="st-err">{String(model.error)}</div>}
      {setModel.isError && <div className="st-err">{String(setModel.error)}</div>}
    </div>
  );
}
