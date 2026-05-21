import { useState } from "react";

import type { TokenKind } from "@/bindings";
import {
  useDeleteProjectToken,
  usePingProjectToken,
  useSetProjectToken,
} from "@/lib/query";

/**
 * 토큰 한 줄 (Notion / GitHub).
 * INVARIANT: 토큰 평문은 **로컬 입력 상태에만** 잠시 머물고, 저장(IPC) 직후 비운다.
 * query/zustand 캐시·백엔드 반환 어디에도 토큰 본문을 두지 않는다. 상태는 boolean(hasToken)만.
 */
export function TokenRow({
  projectId,
  kind,
  label,
  hasToken,
  onToast,
}: {
  projectId: string;
  kind: TokenKind;
  label: string;
  hasToken: boolean;
  onToast: (msg: string) => void;
}) {
  const [token, setToken] = useState("");
  const setTok = useSetProjectToken();
  const delTok = useDeleteProjectToken();
  const ping = usePingProjectToken();

  const save = () => {
    const t = token.trim();
    if (!t || setTok.isPending) return;
    setTok.mutate(
      { projectId, kind, token: t },
      {
        onSuccess: () => {
          setToken(""); // 즉시 비움 — 평문 미보관.
          onToast(`${label} 토큰 저장됨 (keychain)`);
        },
      },
    );
  };

  const clear = () => {
    delTok.mutate(
      { projectId, kind },
      { onSuccess: () => onToast(`${label} 토큰 삭제됨`) },
    );
  };

  const result = ping.data;

  return (
    <div className="st-token">
      <div className="st-token-head">
        <span className="st-token-lbl">{label}</span>
        <span className={hasToken ? "st-status on" : "st-status"}>
          {hasToken ? "● 설정됨" : "○ 미설정"}
        </span>
      </div>

      <div className="st-token-row">
        <input
          className="st-input"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={hasToken ? "새 토큰으로 교체…" : `${label} 토큰 붙여넣기`}
        />
        <button
          type="button"
          className="st-btn sm"
          onClick={save}
          disabled={!token.trim() || setTok.isPending}
        >
          저장
        </button>
        <button
          type="button"
          className="st-btn-ghost sm"
          onClick={() => ping.mutate({ projectId, kind })}
          disabled={!hasToken || ping.isPending}
          title={hasToken ? "토큰으로 API ping" : "먼저 토큰을 저장하세요"}
        >
          {ping.isPending ? "확인 중…" : "Test ping"}
        </button>
        {hasToken && (
          <button
            type="button"
            className="st-btn-ghost sm"
            onClick={clear}
            disabled={delTok.isPending}
          >
            삭제
          </button>
        )}
      </div>

      {ping.isError && <div className="st-err">{String(ping.error)}</div>}
      {result && (
        <div className={result.ok ? "st-ping ok" : "st-ping fail"}>
          {result.ok ? "✓ " : "✗ "}
          {result.detail}
        </div>
      )}
    </div>
  );
}
