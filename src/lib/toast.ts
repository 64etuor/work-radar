/**
 * 전역 토스트 상태 (Zustand).
 *
 * - 에러 토스트: PERSISTENT (dismiss 전까지 유지) + trace id + 복사 버튼.
 * - success/info 토스트: 2500ms 후 자동 dismiss.
 * - 로깅은 fire-and-forget — 실패해도 UI에 영향 없음.
 */
import { create } from "zustand";
import { commands } from "@/bindings";

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

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
  traceId?: string;
  actionUrl?: string;
  actionLabel?: string;
}

interface ToastState {
  toasts: ToastItem[];
  /** 에러 토스트 push. trace id 자동 생성, 로그 fire-and-forget, PERSISTENT. */
  pushError: (
    scope: string,
    message: string,
    opts?: { actionUrl?: string; actionLabel?: string },
  ) => void;
  /** 성공 토스트 push (2500ms 자동 dismiss). */
  pushSuccess: (
    message: string,
    opts?: { actionUrl?: string; actionLabel?: string },
  ) => void;
  /** 정보 토스트 push (2500ms 자동 dismiss). */
  pushInfo: (
    message: string,
    opts?: { actionUrl?: string; actionLabel?: string },
  ) => void;
  /** 토스트 dismiss. */
  dismiss: (id: string) => void;
}

// ── 스토어 ───────────────────────────────────────────────────────────────────

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  pushError(scope, message, opts) {
    const traceId = genTraceId();
    const id = traceId; // trace id를 토스트 id로 재사용 (충돌 가능성 극소).

    // fire-and-forget 로그 — 실패는 조용히 삼킨다 (UI 흐름 보호).
    void commands.logAppError(scope, message, traceId).catch(() => undefined);

    set((s) => ({
      toasts: [
        ...s.toasts,
        {
          id,
          kind: "error" as ToastKind,
          message,
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
