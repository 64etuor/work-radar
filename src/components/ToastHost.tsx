/**
 * ToastHost — 전역 토스트 스택 렌더러.
 *
 * 위치: 화면 우하단 고정. App.tsx 셸에 한 번만 마운트.
 *
 * 에러 토스트:
 *   - 메시지 + "(trace: {traceId})"
 *   - "복사" 버튼: clipboard에 "{message} ({traceId})" 복사
 *   - "×" 버튼: dismiss
 *   - actionUrl이 있으면 action 버튼 렌더
 * success/info 토스트: 간단 메시지 + auto-dismiss (2500ms, 스토어에서 처리).
 */
import { openUrl } from "@tauri-apps/plugin-opener";

import { useToastStore } from "@/lib/toast";

export function ToastHost() {
  const { toasts, dismiss } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast-item toast-${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
        >
          <span className="toast-msg">
            {t.message}
            {t.traceId && (
              <span className="toast-trace"> (trace: {t.traceId})</span>
            )}
          </span>

          <div className="toast-actions">
            {t.traceId && (
              <button
                type="button"
                className="toast-btn toast-copy"
                title="클립보드에 복사"
                onClick={() => {
                  const text = t.traceId
                    ? `${t.message} (${t.traceId})`
                    : t.message;
                  void navigator.clipboard.writeText(text);
                }}
              >
                복사
              </button>
            )}

            {t.actionUrl && (
              <button
                type="button"
                className="toast-btn toast-action"
                onClick={() => void openUrl(t.actionUrl!)}
              >
                {t.actionLabel ?? "열기"}
              </button>
            )}

            <button
              type="button"
              className="toast-btn toast-dismiss"
              title="닫기"
              onClick={() => dismiss(t.id)}
              aria-label="토스트 닫기"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
