import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppError } from "@/bindings";
import { useToastStore } from "@/lib/toast";

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
