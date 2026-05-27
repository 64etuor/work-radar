/**
 * ToastHost — 전역 토스트 스택 렌더러.
 *
 * 위치: 화면 우하단 고정. App.tsx 셸에 한 번만 마운트.
 *
 * 에러 토스트:
 *   - 메시지 + "(trace: {traceId})"
 *   - "복사" 버튼: clipboard에 "{message} ({traceId})" 복사
 *   - "×" 버튼: dismiss
 *   - action(백엔드 AppError) 또는 actionUrl(프런트)이 있으면 action 버튼 렌더
 *   - retryable(transient): onRetry가 있으면 "재시도" 버튼(클릭→refetch+dismiss), 없으면 절제된 힌트
 * success/info 토스트: 간단 메시지 + auto-dismiss (2500ms, 스토어에서 처리).
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import "./ToastHost.css";

import { useToastStore } from "@/lib/toast";
import { useUIStore } from "@/store";
import { NAV_BY_VIEW } from "@/lib/nav";
import type { View } from "@/store";

/** action.nav 문자열이 실제 등록된 View인지 검증(런타임 string → View 좁히기). */
function isView(nav: string): nav is View {
  return Object.prototype.hasOwnProperty.call(NAV_BY_VIEW, nav);
}

export function ToastHost() {
  const { toasts, dismiss } = useToastStore();
  const goTo = useUIStore((s) => s.goTo);

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
            {t.retryable && !t.onRetry && (
              <span className="toast-retry-hint"> · 재시도 가능</span>
            )}
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

            {t.onRetry && (
              <button
                type="button"
                className="toast-btn toast-action"
                title="실패한 요청을 다시 시도"
                onClick={() => {
                  t.onRetry!();
                  dismiss(t.id);
                }}
              >
                재시도
              </button>
            )}

            {t.action && (
              <button
                type="button"
                className="toast-btn toast-action"
                onClick={() => {
                  // url이면 외부 열기, nav면 등록된 뷰로 내부 이동(검증된 경우만).
                  if (t.action!.url) {
                    void openUrl(t.action!.url);
                  } else if (t.action!.nav && isView(t.action!.nav)) {
                    goTo(t.action!.nav);
                  }
                  dismiss(t.id);
                }}
              >
                {t.action.label}
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
