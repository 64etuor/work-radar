import { useEffect, useRef, useState } from "react";

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
  const lastFullLenRef = useRef(0);

  useEffect(() => {
    if (instant) {
      setRevealedLen(fullText.length);
      lastFullLenRef.current = fullText.length;
      return;
    }
    if (fullText.length < lastFullLenRef.current) {
      // text shrank (reset); snap revealer too
      setRevealedLen(fullText.length);
      lastFullLenRef.current = fullText.length;
      return;
    }
    lastFullLenRef.current = fullText.length;
    if (revealedLen >= fullText.length) return;
    const id = window.setInterval(() => {
      setRevealedLen((prev) => {
        if (prev >= fullText.length) {
          window.clearInterval(id);
          return prev;
        }
        return Math.min(prev + charsPerTick, fullText.length);
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [fullText, charsPerTick, intervalMs, instant, revealedLen]);

  return fullText.slice(0, Math.min(revealedLen, fullText.length));
}
