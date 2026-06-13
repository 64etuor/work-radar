import { useEffect, useRef, useState } from "react";

import type { WorkSignal } from "@/bindings";

export function useSignalPop(signals: WorkSignal[]) {
  const [poppedIds, setPoppedIds] = useState<Set<string>>(new Set());
  const knownIdsRef = useRef<Set<string>>(null!);
  const expectPopRef = useRef(false);

  if (knownIdsRef.current === null) {
    knownIdsRef.current = new Set();
  }

  useEffect(() => {
    const current = new Set(signals.map((s) => s.id));
    if (expectPopRef.current) {
      const fresh = signals.filter((s) => !knownIdsRef.current.has(s.id)).map((s) => s.id);
      if (fresh.length) {
        setPoppedIds(new Set(fresh));
        window.setTimeout(() => setPoppedIds(new Set()), 400);
      }
      expectPopRef.current = false;
    }
    knownIdsRef.current = current;
  }, [signals]);

  return { expectPopRef, knownIdsRef, poppedIds };
}
