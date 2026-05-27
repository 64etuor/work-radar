/**
 * 전역 토스트 상태 (Zustand).
 *
 * - 에러 토스트: PERSISTENT (dismiss 전까지 유지) + trace id + 복사 버튼.
 * - success/info 토스트: 2500ms 후 자동 dismiss.
 * - 로깅은 fire-and-forget — 실패해도 UI에 영향 없음.
 */
import { create } from "zustand";
import { commands, type AppError } from "@/bindings";

// ── trace id 생성 ─────────────────────────────────────────────────────────────

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** 8자 base32 trace id 생성 (crypto.getRandomValues 기반). */
export function genTraceId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => BASE32_ALPHABET[b % 32])
    .join("");
}

// ── 타입 ──────────────────────────────────────────────────────────────────────

export type ToastKind = "error" | "success" | "info";

/** AppError.kind 미러(프런트 surfacing 분류). 백엔드 AppError에서만 채워진다. */
export type ToastErrorKind = AppError["kind"];

/** 토스트 액션 힌트 — url(외부 딥링크) 또는 nav(앱 내부 뷰 키) 중 하나. */
export interface ToastAction {
  label: string;
  url?: string;
  nav?: string;
}

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
  traceId?: string;
  actionUrl?: string;
  actionLabel?: string;
  /** 백엔드 AppError 분류(있으면). transient면 retryable 힌트의 근거. */
  errorKind?: ToastErrorKind;
  /** 재시도 가능 여부(AppError.retryable). retryable이고 onRetry가 있으면 "재시도" 버튼 노출. */
  retryable?: boolean;
  /** 재시도 콜백(transient 에러의 실제 refetch 배선). 호출부가 주입(예: query.fetch). */
  onRetry?: () => void;
  /** 액션 버튼(외부 url 또는 내부 nav). */
  action?: ToastAction;
  /**
   * Undo 콜백(info/success 토스트 한정). 사용자가 명시적으로 눌렀을 때만 실행.
   * 자동 dismiss 타이머(2500ms)는 그대로 — 이 시간 안에 누르면 직전 행동을 되돌린다.
   */
  onUndo?: () => void;
  /** Undo 버튼 라벨(기본: "되돌리기"). */
  undoLabel?: string;
}

/** AppError 판별(IpcError.app 또는 backend 결과). traceId + kind로 식별. */
function isAppError(v: unknown): v is AppError {
  return (
    typeof v === "object" &&
    v !== null &&
    "traceId" in v &&
    "kind" in v &&
    "message" in v
  );
}

interface ToastState {
  toasts: ToastItem[];
  /**
   * 에러 토스트 push (PERSISTENT).
   * - `string`(프런트-originated): trace id 생성 + logAppError fire-and-forget(기존 동작).
   * - `AppError`(백엔드-originated): backend traceId 그대로 사용, **재로그 금지**(스펙 §5.3),
   *   kind/retryable/action 보존.
   */
  pushError: (
    scope: string,
    error: string | AppError,
    opts?: { actionUrl?: string; actionLabel?: string; onRetry?: () => void },
  ) => void;
  /** 성공 토스트 push (2500ms 자동 dismiss). */
  pushSuccess: (
    message: string,
    opts?: { actionUrl?: string; actionLabel?: string },
  ) => void;
  /** 정보 토스트 push (2500ms 자동 dismiss). onUndo가 있으면 "되돌리기" 버튼 노출. */
  pushInfo: (
    message: string,
    opts?: {
      actionUrl?: string;
      actionLabel?: string;
      onUndo?: () => void;
      undoLabel?: string;
    },
  ) => void;
  /** 토스트 dismiss. */
  dismiss: (id: string) => void;
}

// ── 스토어 ───────────────────────────────────────────────────────────────────

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  pushError(scope, error, opts) {
    if (isAppError(error)) {
      // 백엔드-originated: traceId 그대로, 재로그 금지(백엔드가 이미 로그함 — 스펙 §5.3 중복 금지).
      const traceId = error.traceId;
      const action: ToastAction | undefined = error.action
        ? {
            label: error.action.label,
            url: error.action.url ?? undefined,
            nav: error.action.nav ?? undefined,
          }
        : undefined;

      set((s) => {
        // 동일 traceId 재유입(중복 토스트/키 충돌) 방지 — append-only 가드.
        if (s.toasts.some((t) => t.id === traceId)) return s;
        return {
          toasts: [
            ...s.toasts,
            {
              id: traceId,
              kind: "error" as ToastKind,
              message: error.message,
              traceId,
              errorKind: error.kind,
              retryable: error.retryable,
              onRetry: opts?.onRetry,
              action,
            },
          ],
        };
      });
      return; // PERSISTENT — 자동 dismiss 없음.
    }

    // 프런트-originated(문자열/일반 Error 메시지): trace id 생성 + 로그(기존 동작).
    const traceId = genTraceId();
    const id = traceId; // trace id를 토스트 id로 재사용 (충돌 가능성 극소).

    // fire-and-forget 로그 — 실패는 조용히 삼킨다 (UI 흐름 보호).
    void commands.logAppError(scope, error, traceId).catch(() => undefined);

    set((s) => ({
      toasts: [
        ...s.toasts,
        {
          id,
          kind: "error" as ToastKind,
          message: error,
          traceId,
          ...opts,
        },
      ],
    }));
    // 에러 토스트는 자동 dismiss 없음 (PERSISTENT).
  },

  pushSuccess(message, opts) {
    const id = genTraceId();
    set((s) => ({
      toasts: [...s.toasts, { id, kind: "success" as ToastKind, message, ...opts }],
    }));
    window.setTimeout(() => get().dismiss(id), 2500);
  },

  pushInfo(message, opts) {
    const id = genTraceId();
    set((s) => ({
      toasts: [...s.toasts, { id, kind: "info" as ToastKind, message, ...opts }],
    }));
    window.setTimeout(() => get().dismiss(id), 2500);
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
