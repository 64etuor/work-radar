import { useEffect, useRef, useState } from "react";

import type { WorkSignal } from "@/bindings";

export function useSignalPop(signals: WorkSignal[]) {
  const [poppedIds, setPoppedIds] = useState<Set<string>>(new Set());
  const knownIdsRef = useRef<Set<string>>(null!);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (knownIdsRef.current === null) {
    knownIdsRef.current = new Set();
  }

  const markPopped = (ids: string | string[]) => {
    const next = Array.isArray(ids) ? ids : [ids];
    if (next.length === 0) return;
    setPoppedIds(new Set(next));
    if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => {
      clearTimerRef.current = null;
      setPoppedIds(new Set());
    }, 400);
  };

  useEffect(() => {
    knownIdsRef.current = new Set(signals.map((s) => s.id));
  }, [signals]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, []);

  return { knownIdsRef, markPopped, poppedIds };
}
