import { useEffect, useRef, useState } from "react";

export interface OauthAttemptState {
  oauthAttempt: { id: number; startedAt: number } | null;
  oauthElapsedMs: number;
  oauthError: string | null;
  setOauthAttempt: React.Dispatch<React.SetStateAction<{ id: number; startedAt: number } | null>>;
  setOauthElapsedMs: React.Dispatch<React.SetStateAction<number>>;
  setOauthError: React.Dispatch<React.SetStateAction<string | null>>;
  /** 새 시도를 시작하고 attemptId를 반환. 동시 시도 추적에 쓴다. */
  beginAttempt: () => number;
  /** 현재 진행 중인 attemptId인지 확인(stale 콜백 무시용). */
  isCurrentAttempt: (id: number) => boolean;
  /** 시도를 완전히 종료(ref 정리). */
  endAttempt: () => void;
}

/**
 * OAuth 시도 상태 기계 — attempt id/startedAt + elapsed setInterval + error 상태를 캡슐화.
 * GoogleAccountBlock이 소비한다. ref 조작은 훅 내부에만 있고 소비자는 시작/확인/종료 API만 쓴다.
 */
export function useOauthAttempt(): OauthAttemptState {
  const [oauthAttempt, setOauthAttempt] = useState<{ id: number; startedAt: number } | null>(null);
  const [oauthElapsedMs, setOauthElapsedMs] = useState(0);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const currentAttemptRef = useRef<number | null>(null);
  const nextAttemptRef = useRef(1);

  useEffect(() => {
    if (!oauthAttempt) {
      return;
    }
    const tick = () => setOauthElapsedMs(Date.now() - oauthAttempt.startedAt);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [oauthAttempt]);

  const beginAttempt = (): number => {
    const id = nextAttemptRef.current++;
    currentAttemptRef.current = id;
    return id;
  };

  const isCurrentAttempt = (id: number): boolean => currentAttemptRef.current === id;

  const endAttempt = (): void => {
    currentAttemptRef.current = null;
  };

  return {
    oauthAttempt,
    oauthElapsedMs,
    oauthError,
    setOauthAttempt,
    setOauthElapsedMs,
    setOauthError,
    beginAttempt,
    isCurrentAttempt,
    endAttempt,
  };
}
