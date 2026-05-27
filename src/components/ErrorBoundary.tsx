/**
 * ErrorBoundary — 렌더타임 크래시 포착(스펙 §6).
 *
 * React class 컴포넌트만 렌더 에러를 잡을 수 있어 class로 구현한다.
 * 크래시 시: DESIGN.md 톤(white editorial) 폴백 UI(메시지 + traceId + 복사) + 백엔드 로그
 * (commands.logAppError, traceId로 토스트/로그 상관) + "다시 시도"(상태 reset) 버튼.
 *
 * 백엔드-originated 에러는 이미 로그되므로, 여기서는 **프런트 렌더 크래시만** 로깅한다
 * (scope="react-error-boundary").
 */
import "./ErrorBoundary.css";

import { Component, type ErrorInfo, type ReactNode } from "react";

import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { genTraceId } from "@/lib/toast";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  traceId: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, traceId: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    // traceId는 렌더 단계에서 생성하지 않고 componentDidCatch(부수효과)에서 부여한다.
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const traceId = genTraceId();
    // 스택 + 컴포넌트 스택 요약(message에 포함 — PII/토큰 없음 가정, 렌더 코드 출처).
    const summary = [
      error.message,
      error.stack?.split("\n").slice(0, 4).join(" | "),
      info.componentStack?.split("\n").slice(0, 4).join(" | "),
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000); // 미니파이된 스택 한 줄이 거대해질 수 있어 바이트 상한.

    this.setState({ traceId });
    // fire-and-forget 로그 — 실패는 조용히 삼킨다(폴백 UI 흐름 보호).
    void commands.logAppError("react-error-boundary", summary, traceId).catch(() => undefined);
  }

  private reset = (): void => {
    this.setState({ error: null, traceId: null });
  };

  render(): ReactNode {
    const { error, traceId } = this.state;
    if (!error) return this.props.children;

    const copyText = traceId ? `${error.message} (${traceId})` : error.message;

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-card">
          <h2 className="error-boundary-title">문제가 발생했어요</h2>
          <p className="error-boundary-msg">{error.message}</p>
          {traceId && <p className="error-boundary-trace">trace: {traceId}</p>}
          <div className="error-boundary-actions">
            <Button className="rounded-full text-[13px] font-semibold" onClick={this.reset}>
              다시 시도
            </Button>
            <Button
              variant="outline"
              className="rounded-full text-[13px] font-semibold"
              onClick={() => void navigator.clipboard.writeText(copyText)}
            >
              복사
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
