import { useEffect, useState } from "react";

interface Opts {
  /** Characters revealed per tick (default 3). Higher = faster reveal. */
  charsPerTick?: number;
  /** Tick interval in ms (default 18 ≈ 55 fps). */
  intervalMs?: number;
  /** If true, instantly snap to full text (e.g. on initial render of historical messages). */
  instant?: boolean;
}

/**
 * Returns a sliding window of `fullText`, revealing characters over time.
 *
 * Behavior:
 * - When `fullText` grows (streaming), the revealer catches up at the configured rate.
 * - When all chunks have arrived, the revealer drains the remaining buffer at the same rate.
 * - When `instant` is set, returns the full text immediately (no animation).
 *
 * The revealer never goes backward; if `fullText` shrinks (shouldn't happen) it's truncated to current length.
 */
export function useTypewriter(fullText: string, opts: Opts = {}): string {
  const { charsPerTick = 3, intervalMs = 18, instant = false } = opts;
  const [revealedLen, setRevealedLen] = useState(instant ? fullText.length : 0);

  // shrink(리셋) 감지는 render 중 prev-compare로 — effect 내 동기 setState는
  // React Compiler 최적화를 깨고(set-state-in-effect) 페인트 전 이중 렌더를 만든다.
  const [prevFullLen, setPrevFullLen] = useState(fullText.length);
  if (fullText.length !== prevFullLen) {
    setPrevFullLen(fullText.length);
    if (instant) {
      // instant 모드: revealer를 항상 최신 길이에 동기 (instant→false 전환 대비).
      setRevealedLen(fullText.length);
    } else if (fullText.length < prevFullLen && revealedLen > fullText.length) {
      // text shrank (reset); snap revealer too
      setRevealedLen(fullText.length);
    }
  }

  useEffect(() => {
    if (instant) return;
    if (revealedLen >= fullText.length) return;
    const id = window.setInterval(() => {
      setRevealedLen((prev) => {
        return Math.min(prev + charsPerTick, fullText.length);
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [fullText, charsPerTick, intervalMs, instant, revealedLen]);

  if (instant) return fullText;
  return fullText.slice(0, Math.min(revealedLen, fullText.length));
}
