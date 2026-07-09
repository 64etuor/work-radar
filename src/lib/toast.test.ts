// @vitest-environment happy-dom
// (dismiss/auto-dismiss가 window.setTimeout으로 제거를 유예한다 — node env엔 window가 없다.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppError } from "@/bindings";
import { TOAST_EXIT_MS as EXIT_MS, useToastStore } from "@/lib/toast";

const AUTO_DISMISS_MS = 2500;

/** isAppError가 받아들이는 최소 AppError 형태(traceId/kind/message + retryable). */
function appError(retryable: boolean, traceId: string): AppError {
  return {
    kind: "transient",
    code: "test.transient",
    message: "일시적 실패",
    traceId,
    retryable,
    action: null,
  } as unknown as AppError;
}

describe("toast retryable refetch 배선", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("retryable AppError + onRetry → 토스트가 onRetry를 보존하고 호출 가능", () => {
    const onRetry = vi.fn();
    const err = appError(true, "trace0001");
    useToastStore.getState().pushError("query", err, { onRetry });

    const t = useToastStore.getState().toasts.find((x) => x.id === "trace0001");
    expect(t).toBeDefined();
    expect(t!.retryable).toBe(true);
    expect(t!.onRetry).toBe(onRetry);

    t!.onRetry!();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("retryable=false면 onRetry 없이 토스트 생성(재시도 버튼 비노출 근거)", () => {
    const err = appError(false, "trace0002");
    useToastStore.getState().pushError("query", err);

    const t = useToastStore.getState().toasts.find((x) => x.id === "trace0002");
    expect(t).toBeDefined();
    expect(t!.retryable).toBe(false);
    expect(t!.onRetry).toBeUndefined();
  });
});

describe("toast 퇴장 수명주기", () => {
  const store = () => useToastStore.getState();

  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dismiss는 즉시 제거하지 않고 leaving 마킹 후 exit 시간이 지나야 제거한다", () => {
    store().pushSuccess("저장했어요");
    const id = store().toasts[0].id;

    store().dismiss(id);
    expect(store().toasts).toHaveLength(1);
    expect(store().toasts[0].leavingSeq).toBeDefined();

    vi.advanceTimersByTime(EXIT_MS - 1);
    expect(store().toasts).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(store().toasts).toHaveLength(0);
  });

  it("auto-dismiss(2500ms)도 같은 leaving 경로를 지난다", () => {
    store().pushInfo("복사했어요");

    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(store().toasts).toHaveLength(1);
    expect(store().toasts[0].leavingSeq).toBeDefined();

    vi.advanceTimersByTime(EXIT_MS);
    expect(store().toasts).toHaveLength(0);
  });

  it("dismiss 연타는 무시한다(제거 타이머 이중 예약 금지)", () => {
    store().pushError("scope", appError(false, "trace0003"));
    const before = vi.getTimerCount();

    store().dismiss("trace0003");
    expect(vi.getTimerCount()).toBe(before + 1);

    store().dismiss("trace0003");
    expect(vi.getTimerCount()).toBe(before + 1);
  });

  it("살아 있는 동일 traceId 에러는 종전대로 중복 억제한다", () => {
    store().pushError("scope", appError(false, "trace0004"));
    store().pushError("scope", appError(true, "trace0004"));

    expect(store().toasts).toHaveLength(1);
    expect(store().toasts[0].retryable).toBe(false); // 첫 번째가 유지된다
  });

  it("fade-out 중인 동일 traceId는 새 에러에 자리를 내주고, 묵은 타이머가 그걸 지우지 않는다", () => {
    store().pushError("scope", appError(false, "trace0005"));
    store().dismiss("trace0005");
    vi.advanceTimersByTime(EXIT_MS / 2);

    // leaving 토스트를 "살아 있는 중복"으로 오인하면 새 에러가 통째로 유실된다.
    store().pushError("scope", appError(true, "trace0005"));
    expect(store().toasts).toHaveLength(1);
    expect(store().toasts[0].leavingSeq).toBeUndefined();
    expect(store().toasts[0].retryable).toBe(true);

    // 먼저 걸린 제거 타이머가 발화해도 갓 들어온 토스트를 지우면 안 된다.
    vi.advanceTimersByTime(EXIT_MS);
    expect(store().toasts).toHaveLength(1);
    expect(store().toasts[0].retryable).toBe(true);
  });

  it("묵은 타이머가 자리를 넘겨받은 뒤 스스로 dismiss된 토스트의 fade를 잘라먹지 않는다", () => {
    // dismiss → 같은 traceId 재유입 → 곧바로 다시 dismiss. 제거 타이머가 (id, leaving)로
    // 대상을 고르면 먼저 걸린 타이머가 두 번째 토스트를 이르게 지운다(fade 절단).
    const half = Math.floor(EXIT_MS / 2);

    store().pushError("scope", appError(false, "trace0006"));
    store().dismiss("trace0006"); // 타이머 R1 @ EXIT_MS
    vi.advanceTimersByTime(half);

    store().pushError("scope", appError(true, "trace0006")); // 자리 교체
    store().dismiss("trace0006"); // 타이머 R2 @ half + EXIT_MS

    vi.advanceTimersByTime(half + 1); // R1 발화 — 두 번째 토스트는 아직 fade 중이어야 한다
    expect(store().toasts).toHaveLength(1);
    expect(store().toasts[0].retryable).toBe(true);

    vi.advanceTimersByTime(EXIT_MS); // R2 발화
    expect(store().toasts).toHaveLength(0);
  });
});
