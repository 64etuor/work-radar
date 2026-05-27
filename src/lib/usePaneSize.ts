import { useCallback, useMemo, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

type PaneSizeOptions = {
  key: string;
  defaultSize: number;
  min: number;
  max: number;
  snap?: number;
  collapsed: boolean;
};

function readSize(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Shared pane sizing primitive: persistent width, min/max, snap and collapse
 * coordination. The component owns the actual DOM layout so the same logic can
 * be reused for nested panes.
 */
export function usePaneSize({
  key,
  defaultSize,
  min,
  max,
  snap = min,
  collapsed,
}: PaneSizeOptions) {
  const storageKey = `wr-pane:${key}`;
  const [size, setSizeState] = useState(() => clamp(readSize(storageKey, defaultSize), min, max));

  const setSize = useCallback(
    (next: number) => {
      const snapped = next <= snap ? min : next;
      const value = clamp(snapped, min, max);
      setSizeState(value);
      try {
        localStorage.setItem(storageKey, String(value));
      } catch {
        /* ignore storage failures */
      }
      return value;
    },
    [max, min, snap, storageKey],
  );

  const bindResizeHandle = useCallback(
    (onSnapCollapse?: () => void) => ({
      role: "separator",
      "aria-orientation": "vertical" as const,
      tabIndex: 0,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startSize = size;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const onMove = (move: PointerEvent) => {
          const next = setSize(startSize + move.clientX - startX);
          if (next <= min && onSnapCollapse) onSnapCollapse();
        };
        const onUp = () => {
          target.releasePointerCapture(event.pointerId);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          const next = setSize(size - 24);
          if (next <= min && onSnapCollapse) onSnapCollapse();
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          setSize(size + 24);
        }
        if (event.key === "Home") {
          event.preventDefault();
          const next = setSize(min);
          if (next <= min && onSnapCollapse) onSnapCollapse();
        }
        if (event.key === "End") {
          event.preventDefault();
          setSize(max);
        }
      },
    }),
    [max, min, setSize, size],
  );

  const style = useMemo(
    () =>
      collapsed
        ? undefined
        : ({
            "--pane-size": `${size}px`,
          } as CSSProperties),
    [collapsed, size],
  );

  return { size, setSize, style, bindResizeHandle };
}
